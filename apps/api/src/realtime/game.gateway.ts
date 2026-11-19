import { type BeforeApplicationShutdown, Inject, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { REDIS } from "../redis/redis.module.ts";
import { AppError, toErrorBody } from "../common/errors.ts";
import { parseInput } from "../common/validation.ts";
import { LIMITS, RateLimitService } from "../common/rate-limit.service.ts";
import { TokenVerifier } from "../auth/token-verifier.ts";
import { UsersService } from "../users/users.service.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { RoomsService } from "../rooms/rooms.service.ts";
import { SnapshotService } from "../rooms/snapshot.service.ts";
import { Broadcaster } from "./broadcaster.service.ts";
import { GameService } from "./game.service.ts";
import { PresenceService } from "./presence.service.ts";
import {
  ClientEvents as C,
  NAMESPACE,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ServerEvents as E,
  channel,
  type AckResult,
} from "./protocol.ts";

interface SocketData {
  user?: AuthUser;
  displayRoomId?: string;
  rooms: Set<string>;
}
type GameSocket = Socket & { data: SocketData };

const uuid = z.string().uuid();
const idem = z.string().min(8).max(100);
const roomCmd = z.object({ roomId: uuid, idempotencyKey: idem });
const joinCmd = z.object({ roomId: uuid, resumeToken: z.string().min(16).max(200), protocolVersion: z.number().int().default(PROTOCOL_VERSION) });
const answerCmd = z.object({ roomId: uuid, matchQuestionId: uuid, optionKey: z.string().min(1).max(4), idempotencyKey: idem });
const lockCmd = roomCmd.extend({ locked: z.boolean() });
const removeCmd = roomCmd.extend({ playerId: uuid });
const readyCmd = z.object({ roomId: uuid, ready: z.boolean().default(true) });
const displayCmd = z.object({ roomId: uuid, displayToken: z.string().min(16).max(200) });

// Authenticated Socket.IO gateway (spec 12). Players and hosts connect with a
// Supabase access token in `auth.token`; a Big Screen connects with
// `auth.displayToken` and can only listen.
@WebSocketGateway({ namespace: NAMESPACE, cors: { origin: true, credentials: true } })
export class GameGateway implements OnGatewayInit, OnGatewayDisconnect, BeforeApplicationShutdown {
  private readonly log = new Logger("GameGateway");
  private ns?: Namespace;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly users: UsersService,
    private readonly game: GameService,
    private readonly rooms: RoomsService,
    private readonly snapshots: SnapshotService,
    private readonly presence: PresenceService,
    private readonly broadcaster: Broadcaster,
    private readonly rateLimit: RateLimitService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  afterInit(ns: Namespace) {
    this.ns = ns;
    this.broadcaster.attach(ns);
    ns.use(async (socket, next) => {
      const s = socket as GameSocket;
      s.data.rooms = new Set();
      try {
        const ip = socket.handshake.address || "unknown";
        await this.rateLimit.hit("socketConnect", ip, LIMITS.socketConnect.limit, LIMITS.socketConnect.windowSec);
        const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
        if (typeof auth.token === "string" && auth.token) {
          s.data.user = await this.users.resolve(await this.verifier.verify(auth.token));
          await socket.join(channel.user(s.data.user.id));
          return next();
        }
        if (typeof auth.displayToken === "string" && auth.displayToken) {
          const row = await this.rooms.verifyDisplayToken(auth.displayToken);
          if (!row) throw new AppError("UNAUTHORIZED", "This display link is no longer valid.");
          s.data.displayRoomId = row.roomId;
          await socket.join(channel.display(row.roomId));
          return next();
        }
        throw new AppError("UNAUTHORIZED");
      } catch (err) {
        const { body } = toErrorBody(err);
        const e = new Error(body.message) as Error & { data: unknown };
        e.data = body;
        next(e);
      }
    });
    ns.on("connection", (socket) => {
      const s = socket as GameSocket;
      if (s.data.displayRoomId) {
        void this.snapshots.build(s.data.displayRoomId, null).then((snapshot) => {
          socket.emit(E.roomSnapshot, this.broadcaster.envelope(s.data.displayRoomId!, { snapshot }));
        });
      }
    });
  }

  handleDisconnect(socket: GameSocket) {
    const user = socket.data.user;
    if (!user) return;
    const work = (async () => {
      for (const roomId of socket.data.rooms ?? []) {
        const last = await this.presence.remove(roomId, user.id, socket.id).catch(() => false);
        if (last) await this.game.disconnected(roomId, user.id).catch((err: unknown) => this.log.warn(`disconnect handling failed: ${String(err)}`));
      }
    })();
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  // On shutdown, drop sockets first and let their presence updates finish
  // while Redis and Postgres are still open. Clients reconnect elsewhere and
  // resync from a snapshot.
  async beforeApplicationShutdown() {
    this.ns?.disconnectSockets(true);
    // Disconnect handlers are dispatched asynchronously; give them a moment
    // to register before draining.
    await new Promise((r) => setTimeout(r, 150));
    const deadline = new Promise((r) => setTimeout(r, 3000));
    await Promise.race([Promise.allSettled([...this.pending]), deadline]);
    this.broadcaster.stop();
  }

  // Wraps a handler: validation, error envelope, and the acknowledgement.
  private async ack<T>(socket: GameSocket, fn: () => Promise<T>): Promise<AckResult<T>> {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      const { body } = toErrorBody(err);
      if (!(err instanceof AppError)) this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      return { ok: false, error: { code: body.code, message: body.message, details: body.details } };
    }
  }

  private requireUser(socket: GameSocket): AuthUser {
    if (!socket.data.user) throw new AppError("FORBIDDEN", "The Big Screen view is read-only.");
    return socket.data.user;
  }

  private requireJoined(socket: GameSocket, roomId: string) {
    if (!socket.data.rooms.has(roomId)) throw new AppError("FORBIDDEN", "Join the room first.");
  }

  // Idempotent command execution (spec 12.3): a repeated key returns the
  // original result instead of running the command again.
  private async once<T>(userId: string, event: string, key: string, fn: () => Promise<T>): Promise<T> {
    const redisKey = `idem:${userId}:${event}:${key}`;
    const claimed = await this.redis.set(redisKey, JSON.stringify({ pending: true }), "EX", 3600, "NX");
    if (!claimed) {
      for (let i = 0; i < 40; i += 1) {
        const stored = JSON.parse((await this.redis.get(redisKey)) ?? "{}") as { pending?: boolean; result?: T; error?: { code: string; message: string } };
        if (!stored.pending) {
          if (stored.error) throw new AppError(stored.error.code as never, stored.error.message);
          return stored.result as T;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new AppError("INVALID_STATE", "That command is still being processed.");
    }
    try {
      const result = await fn();
      await this.redis.set(redisKey, JSON.stringify({ result }), "EX", 3600);
      return result;
    } catch (err) {
      if (err instanceof AppError) {
        await this.redis.set(redisKey, JSON.stringify({ error: { code: err.code, message: err.message } }), "EX", 3600);
      } else {
        await this.redis.del(redisKey);
      }
      throw err;
    }
  }

  private async hostCommand<T>(socket: GameSocket, event: string, body: unknown, schema: z.ZodType<{ roomId: string; idempotencyKey: string }>, fn: (user: AuthUser, input: z.infer<typeof schema>) => Promise<T>) {
    return this.ack(socket, async () => {
      const user = this.requireUser(socket);
      const input = parseInput(schema, body);
      this.requireJoined(socket, input.roomId);
      await this.rateLimit.hit("hostCommand", user.id, LIMITS.hostCommand.limit, LIMITS.hostCommand.windowSec);
      return this.once(user.id, event, input.idempotencyKey, () => fn(user, input));
    });
  }

  @SubscribeMessage(C.roomJoin)
  async onJoin(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.ack(socket, async () => {
      const user = this.requireUser(socket);
      const input = parseInput(joinCmd, body);
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(input.protocolVersion)) {
        throw new AppError("VALIDATION_ERROR", "Please update the app to keep playing.", { supported: SUPPORTED_PROTOCOL_VERSIONS });
      }
      await this.game.verifySeat(input.roomId, user.id, input.resumeToken);
      await socket.join(channel.members(input.roomId));
      socket.data.rooms.add(input.roomId);
      await this.presence.add(input.roomId, user.id, socket.id);
      await this.game.connected(input.roomId, user.id);
      const snapshot = await this.snapshots.build(input.roomId, user.id);
      socket.emit(E.roomSnapshot, this.broadcaster.envelope(input.roomId, { snapshot }));
      return { snapshot };
    });
  }

  @SubscribeMessage(C.roomSync)
  async onSync(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.ack(socket, async () => {
      const { roomId } = parseInput(z.object({ roomId: uuid }), body);
      if (socket.data.displayRoomId === roomId) return { snapshot: await this.snapshots.build(roomId, null) };
      const user = this.requireUser(socket);
      this.requireJoined(socket, roomId);
      if (await this.game.removedFromRoom(roomId, user.id)) throw new AppError("PLAYER_REMOVED");
      return { snapshot: await this.snapshots.build(roomId, user.id) };
    });
  }

  @SubscribeMessage(C.roomLeave)
  async onLeave(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.ack(socket, async () => {
      const user = this.requireUser(socket);
      const { roomId } = parseInput(z.object({ roomId: uuid }), body);
      this.requireJoined(socket, roomId);
      socket.data.rooms.delete(roomId);
      await socket.leave(channel.members(roomId));
      await this.presence.clear(roomId, user.id);
      return this.game.leave(roomId, user.id);
    });
  }

  @SubscribeMessage(C.playerReady)
  async onReady(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.ack(socket, async () => {
      const user = this.requireUser(socket);
      const input = parseInput(readyCmd, body);
      this.requireJoined(socket, input.roomId);
      return this.game.setReady(input.roomId, user.id, input.ready);
    });
  }

  @SubscribeMessage(C.answerSubmit)
  async onAnswer(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    const result = await this.ack(socket, async () => {
      const user = this.requireUser(socket);
      const input = parseInput(answerCmd, body);
      this.requireJoined(socket, input.roomId);
      await this.rateLimit.hit("answer", user.id, LIMITS.answer.limit, LIMITS.answer.windowSec);
      return this.game.submitAnswer(user.id, input);
    });
    if (!result.ok) {
      const roomId = (body as { roomId?: string } | null)?.roomId ?? "";
      socket.emit(E.answerRejected, this.broadcaster.envelope(roomId, { ...result.error }));
    }
    return result;
  }

  @SubscribeMessage(C.hostStart)
  onStart(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostStart, body, roomCmd, (u, i) => this.game.start(i.roomId, u.id));
  }

  @SubscribeMessage(C.hostNext)
  onNext(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostNext, body, roomCmd, (u, i) => this.game.next(i.roomId, u.id));
  }

  @SubscribeMessage(C.hostPause)
  onPause(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostPause, body, roomCmd, (u, i) => this.game.pause(i.roomId, u.id));
  }

  @SubscribeMessage(C.hostResume)
  onResume(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostResume, body, roomCmd, (u, i) => this.game.resume(i.roomId, u.id));
  }

  @SubscribeMessage(C.hostLock)
  onLock(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostLock, body, lockCmd, (u, i) => this.game.lockLobby(i.roomId, u.id, (i as z.infer<typeof lockCmd>).locked));
  }

  @SubscribeMessage(C.hostRemove)
  onRemove(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostRemove, body, removeCmd, (u, i) => this.game.removePlayer(i.roomId, u.id, (i as z.infer<typeof removeCmd>).playerId));
  }

  @SubscribeMessage(C.hostClose)
  onClose(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.hostCommand(socket, C.hostClose, body, roomCmd, (u, i) => this.game.close(i.roomId, u.id, "host_closed"));
  }

  // Alternative to connecting with auth.displayToken: an already-open socket
  // can subscribe a Big Screen view. It still cannot send commands.
  @SubscribeMessage(C.displaySubscribe)
  async onDisplay(@ConnectedSocket() socket: GameSocket, @MessageBody() body: unknown) {
    return this.ack(socket, async () => {
      const input = parseInput(displayCmd, body);
      const row = await this.rooms.verifyDisplayToken(input.displayToken);
      if (!row || row.roomId !== input.roomId) throw new AppError("UNAUTHORIZED", "This display link is no longer valid.");
      await socket.join(channel.display(row.roomId));
      return { snapshot: await this.snapshots.build(row.roomId, null) };
    });
  }
}
