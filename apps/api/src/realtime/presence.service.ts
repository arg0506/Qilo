import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../redis/redis.module.ts";

// Which sockets each member has open in a room, shared across instances. A
// member counts as connected while at least one socket is present.
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(roomId: string, userId: string) {
    return `presence:${roomId}:${userId}`;
  }

  // Returns true when this is the member's first open socket.
  async add(roomId: string, userId: string, socketId: string): Promise<boolean> {
    const key = this.key(roomId, userId);
    const [[, added], [, size]] = (await this.redis.multi().sadd(key, socketId).scard(key).expire(key, 86_400).exec()) as [
      [null, number],
      [null, number],
      unknown,
    ];
    return added === 1 && size === 1;
  }

  // Returns true when the member has no sockets left.
  async remove(roomId: string, userId: string, socketId: string): Promise<boolean> {
    const key = this.key(roomId, userId);
    const [[, removed], [, size]] = (await this.redis.multi().srem(key, socketId).scard(key).exec()) as [
      [null, number],
      [null, number],
    ];
    return removed === 1 && size === 0;
  }

  async clear(roomId: string, userId: string) {
    await this.redis.del(this.key(roomId, userId));
  }
}
