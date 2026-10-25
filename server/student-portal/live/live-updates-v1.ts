import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { scopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import {
  liveAudienceV1,
  livePublishEventV1,
  liveResumeV1,
  type LivePublishEventV1,
} from '../../../shared/student-portal-contracts/live-v1';
import type { PortalCompositionEnvV1 } from '../composition/config-v1';
import { PortalSignalBufferV1 } from '../observability/signal-buffer-v1';
import { answerLiveCloseV1, failLiveSocketV1 } from './live-close-v1';

const socketIdentityV1 = z
  .object({
    purpose: z.enum(['academic', 'security']).default('academic'),
    authorizedAt: z.number().optional(),
    invalidatedAt: z.number().optional(),
    connectionId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    audience: liveAudienceV1,
    expiresAt: z.iso.datetime({ offset: true }),
    accountId: z.uuid().nullable(),
    studentId: z.number().int().positive().safe().nullable(),
    classId: z.number().int().positive().safe().nullable(),
  })
  .strict();
type SocketIdentityV1 = z.infer<typeof socketIdentityV1> & { resumed: boolean };
const socketAttachmentV1 = socketIdentityV1.extend({ resumed: z.boolean() }).strict();

/** One SQLite-backed coordination atom per authenticated audience/year. Browser sockets never access it directly. */

/** The socket identity the authenticated HTTP composition put in the private headers. */
function socketIdentityInputV1(headers: Headers) {
  return {
    purpose: headers.get('x-live-purpose') ?? 'academic',
    authorizedAt: Date.now(),
    ...(headers.has('x-live-connection-id') ? { connectionId: headers.get('x-live-connection-id'), sessionId: headers.get('x-live-session-id') } : {}),
    audience: headers.get('x-live-audience'),
    expiresAt: headers.get('x-live-expires-at'),
    accountId: headers.get('x-live-account-id') || null,
    studentId: headers.get('x-live-student-id')
      ? Number(headers.get('x-live-student-id'))
      : null,
    classId: headers.get('x-live-class-id')
      ? Number(headers.get('x-live-class-id'))
      : null,
  };
}

/** Not expired; a student has an account and a student; an admin has neither nor a class; the
 * security channel is only for students. */
function consistentIdentityV1(data: z.infer<typeof socketIdentityV1>) {
  if (Date.parse(data.expiresAt) <= Date.now()) return false;
  if (data.audience === 'student' && (!data.accountId || !data.studentId)) return false;
  if (data.audience === 'admin' && (data.accountId || data.studentId || data.classId)) return false;
  return data.purpose !== 'security' || data.audience === 'student';
}

function sendOrCloseV1(socket: WebSocket, message: string) {
  try {
    socket.send(message);
  } catch {
    socket.close(1011, 'delivery-failed');
  }
}

/** Invalidate presence immediately; a fresh authenticated verification restores it. */
function reauthorizeV1(socket: WebSocket, identity: SocketIdentityV1) {
  socket.serializeAttachment({ ...identity, authorizedAt: 0, invalidatedAt: Date.now() });
  sendOrCloseV1(socket, JSON.stringify({ contractVersion: 1, type: 'reauthorize' }));
}

export class PortalLiveUpdatesV1 extends DurableObject<PortalCompositionEnvV1> {
  private signals: PortalSignalBufferV1 | undefined;
  constructor(ctx: DurableObjectState, env: PortalCompositionEnvV1) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('security-ping', 'security-pong'),
    );
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS live_head_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      cursor TEXT NOT NULL,
      domain TEXT NOT NULL,
      version TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )`);
  }
  private signalBuffer(): PortalSignalBufferV1 {
    if (this.signals) return this.signals;
    const sql = this.ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS operational_signal_checkpoint_v1 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)',
    );
    this.signals = new PortalSignalBufferV1({
      read: () => {
        const row = sql
          .exec<{ payload: string }>(
            'SELECT payload FROM operational_signal_checkpoint_v1 WHERE singleton=1',
          )
          .toArray()[0];
        try {
          return row ? (JSON.parse(row.payload) as unknown) : null;
        } catch {
          return null;
        }
      },
      write: (value) => {
        sql.exec(
          'INSERT INTO operational_signal_checkpoint_v1(singleton,payload) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload',
          JSON.stringify(value),
        );
      },
    });
    return this.signals;
  }
  async recordOperationalSignal(input: unknown): Promise<boolean> {
    return this.signalBuffer().record(input);
  }
  async operationalSignals() {
    return this.signalBuffer().snapshot();
  }

  private head(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ cursor: string }>('SELECT cursor FROM live_head_v1 WHERE singleton=1')
      .toArray()[0];
    return row?.cursor ?? null;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 404 });
    const parsed = socketIdentityV1.safeParse(socketIdentityInputV1(request.headers));
    if (!parsed.success || !consistentIdentityV1(parsed.data))
      return new Response(null, { status: 403 });
    const effectiveHeader = request.headers.get('x-live-effective-expires-at');
    const effectiveExpiry = z.iso
      .datetime({ offset: true })
      .safeParse(
        parsed.data.purpose === 'security' && effectiveHeader !== null
          ? effectiveHeader
          : parsed.data.expiresAt,
      );
    if (
      !effectiveExpiry.success ||
      Date.parse(effectiveExpiry.data) < Date.parse(parsed.data.expiresAt)
    )
      return new Response(null, { status: 403 });
    const effectiveExpiresAt = effectiveExpiry.data;
    if (parsed.data.purpose === 'security')
      parsed.data.expiresAt = new Date(
        Math.min(Date.parse(parsed.data.expiresAt), Date.now() + 60_000),
      ).toISOString();
    const pair = new WebSocketPair();
    const client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server, [parsed.data.audience,
      ...(parsed.data.connectionId ? ['connection:' + parsed.data.connectionId] : []),
    ]);
    server.serializeAttachment({ ...parsed.data, resumed: false } satisfies SocketIdentityV1);
    if (parsed.data.purpose === 'security')
      server.send(
        JSON.stringify({
          contractVersion: 1,
          type: 'security-connected',
          ...(parsed.data.connectionId && parsed.data.sessionId ? { renewable: true } : {}),
          // Older callers provide only the short lease, not the session expiry.
          ...(effectiveHeader === null ? {} : { expiresAt: effectiveExpiresAt }),
        }),
      );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Private RPC: only the HTTP composition supplies freshly cookie-authorized identities. */
  async renewSecurity(input: unknown): Promise<boolean> {
    const renewal = z.object({
      connectionId: z.uuid(), sessionId: z.uuid(), accountId: z.uuid(),
      studentId: z.number().int().positive().safe(), classId: z.number().int().positive().safe().nullable(),
      verifiedAt: z.number().int().positive(), expiresAt: z.iso.datetime({ offset: true }),
    }).strict().parse(input);
    const now = Date.now();
    const end = Math.min(Date.parse(renewal.expiresAt), renewal.verifiedAt + 60_000);
    if (renewal.verifiedAt > now || end <= now) return false;
    for (const socket of this.ctx.getWebSockets('connection:' + renewal.connectionId)) {
      const parsed = socketAttachmentV1.safeParse(socket.deserializeAttachment());
      if (!parsed.success || socket.readyState !== 1) continue;
      const identity = parsed.data;
      if (identity.purpose !== 'security' || identity.connectionId !== renewal.connectionId ||
          identity.sessionId !== renewal.sessionId || identity.accountId !== renewal.accountId) continue;
      // A verification started before an intervening security notice or a newer result cannot
      // restore presence. Use server timestamps, never a browser-provided authorization time.
      if (renewal.verifiedAt <= (identity.invalidatedAt ?? 0) ||
          renewal.verifiedAt <= (identity.authorizedAt ?? 0)) return false;
      socket.serializeAttachment({ ...identity, authorizedAt: renewal.verifiedAt,
        expiresAt: new Date(end).toISOString(), studentId: renewal.studentId, classId: renewal.classId });
      return true;
    }
    return false;
  }

  async publish(input: unknown): Promise<'delivered' | 'duplicate'> {
    const event = livePublishEventV1.parse(input);
    const previous = this.head();
    const outOfOrder = previous !== null && previous >= event.cursor;
    if (!outOfOrder)
      this.ctx.storage.sql.exec(
        `INSERT INTO live_head_v1(singleton,cursor,domain,version,occurred_at) VALUES(1,?,?,?,?)
       ON CONFLICT(singleton) DO UPDATE SET cursor=excluded.cursor,domain=excluded.domain,
         version=excluded.version,occurred_at=excluded.occurred_at WHERE excluded.cursor>live_head_v1.cursor`,
        event.cursor,
        event.domain,
        event.version,
        event.occurredAt,
      );
    // Sequence allocation is not commit/delivery order. A late event or an ambiguous retry
    // must not disappear just because another domain advanced the high-water cursor.
    const message = JSON.stringify(
      outOfOrder
        ? { contractVersion: 1, type: 'resync', cursor: previous, domains: [event.domain] }
        : {
            contractVersion: 1,
            type: 'change',
            cursor: event.cursor,
            domain: event.domain,
            version: event.version,
            occurredAt: event.occurredAt,
          },
    );
    for (const socket of this.ctx.getWebSockets(event.audience)) {
      const identity = socketAttachmentV1.safeParse(socket.deserializeAttachment());
      if (!identity.success || Date.parse(identity.data.expiresAt) <= Date.now()) {
        socket.close(4401, 'authorization-expired');
        continue;
      }
      if (event.audience === 'student' && !this.matches(identity.data, event)) continue;
      if (identity.data.purpose === 'security') {
        if (event.securityRelevant) reauthorizeV1(socket, identity.data);
        continue;
      }
      sendOrCloseV1(socket, message);
    }
    return outOfOrder ? 'duplicate' : 'delivered';
  }

  private matches(identity: z.infer<typeof socketIdentityV1>, event: LivePublishEventV1): boolean {
    if (event.accountId) return identity.accountId === event.accountId;
    if (event.classId) return identity.classId === event.classId;
    if (event.studentIds.length)
      return identity.studentId !== null && event.studentIds.includes(identity.studentId);
    return true;
  }

  /** Named internal RPC only. No identities leave this aggregate. */
  async presence(input: unknown) {
    const scope = scopeV1.parse(input);
    const now = Date.now();
    const students = new Set<number>();
    for (const socket of this.ctx.getWebSockets('student')) {
      const parsed = socketAttachmentV1.safeParse(socket.deserializeAttachment());
      if (!parsed.success || socket.readyState !== 1) continue;
      const identity = parsed.data;
      if (
        identity.purpose !== 'security' ||
        !identity.studentId ||
        !identity.authorizedAt ||
        now - identity.authorizedAt >= 60_000 ||
        Date.parse(identity.expiresAt) <= now
      )
        continue;
      const observed =
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? identity.authorizedAt;
      if (now - observed >= 60_000) continue;
      if (scope.kind === 'class' && scope.classId !== identity.classId) continue;
      if (scope.kind === 'account' && scope.accountId.toLowerCase() !== identity.accountId)
        continue;
      students.add(identity.studentId);
    }
    return {
      connectedStudents: students.size,
      observedAt: new Date(now).toISOString(),
      windowSeconds: 60,
    };
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || message.length > 512) {
      socket.close(1003, 'invalid-message');
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(message);
    } catch {
      socket.close(1003, 'invalid-message');
      return;
    }
    const resume = liveResumeV1.safeParse(input);
    const identity = socketAttachmentV1.safeParse(socket.deserializeAttachment());
    if (!identity.success || Date.parse(identity.data.expiresAt) <= Date.now()) {
      socket.close(4401, 'authorization-expired');
      return;
    }
    if (identity.data.purpose === 'security') {
      socket.close(1003, 'invalid-message');
      return;
    }
    if (!resume.success) {
      socket.close(1003, 'invalid-message');
      return;
    }
    const cursor = this.head();
    // A high-water cursor cannot prove that all smaller transactions committed before
    // disconnection. Always revalidate once on reconnect if either side has history.
    const needsResync = cursor !== null || resume.data.cursor !== null;
    socket.send(
      JSON.stringify(
        needsResync
          ? { contractVersion: 1, type: 'resync', cursor, domains: ['gradebook', 'portal'] }
          : { contractVersion: 1, type: 'connected', cursor },
      ),
    );
    socket.serializeAttachment({ ...identity.data, resumed: true } satisfies SocketIdentityV1);
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    answerLiveCloseV1(socket, code, reason);
  }
  override webSocketError(socket: WebSocket): void {
    failLiveSocketV1(socket);
  }
}
