import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Server, ServerOptions } from "socket.io";
import { createRedis } from "../redis/redis.module.ts";

// Socket.IO Redis adapter (spec 13.4) so broadcasts reach sockets on every
// instance behind the load balancer.
export class RedisIoAdapter extends IoAdapter {
  private readonly pub;
  private readonly sub;

  constructor(app: INestApplicationContext, redisUrl: string, private readonly corsOrigins: string[] | "*") {
    super(app);
    this.pub = createRedis(redisUrl);
    this.sub = this.pub.duplicate();
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigins === "*" ? true : this.corsOrigins, credentials: true },
      // Connection state recovery is off: clients always resync from a snapshot.
      pingInterval: 10_000,
      pingTimeout: 8_000,
    }) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async close(server: Server) {
    await super.close(server);
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
