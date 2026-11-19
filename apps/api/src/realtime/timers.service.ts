import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { createRedis } from "../redis/redis.module.ts";
import { jobId, type TimerJob } from "./effects.ts";

const QUEUE = "qilo-game-timers";

// Durable game timers (spec 13.1, 13.4). Every deadline is a delayed BullMQ
// job in Redis, so a restarted or different instance still fires it. Every
// handler is idempotent and re-checks state, so a duplicate or stale job does
// nothing.
@Injectable()
export class TimersService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("Timers");
  private queue!: Queue;
  private worker?: Worker;
  private handler?: (job: TimerJob) => Promise<void>;
  private readonly connections: ReturnType<typeof createRedis>[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit() {
    this.queue = new Queue(QUEUE, {
      connection: this.connection(),
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 1000, attempts: 3, backoff: { type: "fixed", delay: 200 } },
    });
  }

  register(handler: (job: TimerJob) => Promise<void>) {
    this.handler = handler;
    if (!this.config.RUN_WORKERS || this.worker) return;
    this.worker = new Worker(
      QUEUE,
      async (job: Job<TimerJob>) => {
        await this.handler!(job.data);
      },
      { connection: this.connection(), concurrency: 32 },
    );
    this.worker.on("failed", (job, err) => this.log.error(`timer ${job?.name} failed: ${err.message}`));
  }

  private connection() {
    const c = createRedis(this.config.REDIS_URL);
    this.connections.push(c);
    return c;
  }

  async schedule(job: TimerJob, delayMs: number) {
    await this.queue.add(job.type, job, { jobId: jobId(job), delay: delayMs });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    // BullMQ does not close connections it was handed.
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}
