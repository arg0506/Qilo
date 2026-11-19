import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Namespace } from "socket.io";
import { PROTOCOL_VERSION, channel } from "./protocol.ts";
import type { Emit } from "./effects.ts";

// Delivers events to Socket.IO channels. With the Redis adapter installed,
// a broadcast from any instance reaches sockets on every instance.
@Injectable()
export class Broadcaster {
  private ns?: Namespace;
  private stopped = false;

  // Called during shutdown, after sockets are drained and before the Redis
  // adapter closes, so no publish runs on a closed connection.
  stop() {
    this.stopped = true;
  }

  attach(ns: Namespace) {
    this.ns = ns;
  }

  get namespace(): Namespace | undefined {
    return this.ns;
  }

  envelope(roomId: string, payload: Record<string, unknown>) {
    return { protocolVersion: PROTOCOL_VERSION, eventId: randomUUID(), roomId, ...payload };
  }

  send(emit: Emit) {
    if (!this.ns || this.stopped) return;
    const body = this.envelope(emit.roomId, emit.payload);
    if (emit.kind === "user") {
      this.ns.to(channel.user(emit.userId)).emit(emit.event, body);
      return;
    }
    if (emit.audience === "members") this.ns.to(channel.members(emit.roomId)).emit(emit.event, body);
    else if (emit.audience === "display") this.ns.to(channel.display(emit.roomId)).emit(emit.event, body);
    else this.ns.to([channel.members(emit.roomId), channel.display(emit.roomId)]).emit(emit.event, body);
  }

  // Removes every socket of a user from a room's member channel.
  async evict(roomId: string, userId: string) {
    if (!this.ns) return;
    this.ns.in(channel.user(userId)).socketsLeave(channel.members(roomId));
  }

  async closeDisplays(roomId: string) {
    if (!this.ns) return;
    this.ns.in(channel.display(roomId)).socketsLeave(channel.display(roomId));
  }
}
