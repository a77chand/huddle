import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import * as core from '@huddle/core';
import { HuddleError, type CheckInPolicy, type GeoFix, type Result, type Session } from '@huddle/core';
import { bareCard, type CardMaker } from './ai.ts';
import { render } from './messages.ts';
import { deliver, type Sender } from './notify.ts';
import { Store, type Auth } from './store.ts';

export interface AppOptions {
  store: Store;
  sender: Sender;
  makeCard: CardMaker;
  now?: () => number;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions) {
  const { store, sender, makeCard } = opts;
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024, trustProxy: true });
  const log = (msg: string) => app.log.warn(msg);
  const live = new Map<string, Set<{ ws: WebSocket; memberId: string }>>();
  const pending = new Set<Promise<unknown>>();
  const limiter = rateLimiter();

  await app.register(websocket);
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HuddleError) return reply.code(err.code === 'no-member' ? 403 : 400).send({ error: err.code, message: err.message });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad-request', message: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'something went wrong' });
  });

  function view(session: Session, memberId: string) {
    const t = now();
    const b = core.board(session, t);
    return {
      me: memberId,
      joinCode: store.joinCode(session.id),
      // Only members ever see this (every view is authenticated).
      proximityKey: session.endedAt === null ? session.proximityKey : null,
      board: b,
      incidents: b.rows.filter((r) => r.needsAttention).map((r) => core.incident(session, r.id, t)!),
      timeline: session.timeline.slice(-50),
    };
  }

  function broadcast(session: Session) {
    for (const c of live.get(session.id) ?? []) {
      try {
        c.ws.send(JSON.stringify({ type: 'view', view: view(session, c.memberId) }));
      } catch {
        /* closed socket; cleaned up on 'close' */
      }
    }
  }

  /** Persist a result, then notify phones and contacts. Delivery never delays the response. */
  function commit(r: Result) {
    store.save(r.session);
    broadcast(r.session);
    if (r.effects.length) {
      const out = render(r.session, r.effects, now());
      const p = deliver(sender, store.pushTokens(r.session.id), out, log).finally(() => pending.delete(p));
      pending.add(p);
    }
    return r.session;
  }

  function authed(req: FastifyRequest, token?: string): Auth & { session: Session } {
    const raw = token ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const auth = raw ? store.auth(raw) : null;
    if (!auth) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
    if (!limiter(`t:${auth.memberId}`, 120)) throw new HttpError(429, 'slow-down', 'too many requests');
    const session = store.get(auth.sessionId);
    if (!session) throw new HttpError(404, 'gone', 'this session no longer exists');
    return { ...auth, session };
  }

  function mutate(req: FastifyRequest, fn: (s: Session, me: string, t: number) => Result) {
    const a = authed(req);
    return view(commit(fn(a.session, a.memberId, now())), a.memberId);
  }

  app.get('/health', async () => ({ ok: true }));

  app.post('/v1/sessions', async (req) => {
    if (!limiter(`ip:${req.ip}`, 20)) throw new HttpError(429, 'slow-down', 'too many sessions');
    const b = body(req);
    const memberId = randomUUID();
    const t = now();
    const { session } = core.createSession({
      id: randomUUID(),
      name: str(b.name, 'name', 80),
      now: t,
      durationHours: b.durationHours === undefined ? undefined : num(b.durationHours, 'durationHours'),
      timeZone: typeof b.timeZone === 'string' ? b.timeZone : undefined,
      proximityKey: randomBytes(16).toString('hex'),
      founder: { id: memberId, name: str(b.memberName, 'memberName', 40), phone: optStr(b.phone), policy: policy(b.policy) },
    });
    store.insert(session);
    const token = store.issueToken({ sessionId: session.id, memberId });
    return { token, ...view(session, memberId) };
  });

  app.post('/v1/join', async (req) => {
    if (!limiter(`ip:${req.ip}`, 20)) throw new HttpError(429, 'slow-down', 'too many attempts');
    const b = body(req);
    const found = store.byJoinCode(str(b.joinCode, 'joinCode', 12));
    if (!found) throw new HttpError(404, 'no-session', 'no session with that code');
    const memberId = randomUUID();
    const session = commit(
      core.join(found, { id: memberId, name: str(b.memberName, 'memberName', 40), phone: optStr(b.phone), policy: policy(b.policy) }, now()),
    );
    const token = store.issueToken({ sessionId: session.id, memberId });
    return { token, ...view(session, memberId) };
  });

  app.get('/v1/session', async (req) => {
    const a = authed(req);
    return view(a.session, a.memberId);
  });

  app.post('/v1/check-in', async (req) => {
    const b = body(req);
    return mutate(req, (s, me, t) =>
      core.checkIn(s, me, t, { location: geo(b.location, t), battery: b.battery === undefined ? undefined : num(b.battery, 'battery') }),
    );
  });

  app.post('/v1/snooze', async (req) => mutate(req, (s, me, t) => core.snooze(s, me, num(body(req).minutes, 'minutes'), t)));

  app.post('/v1/sos', async (req) => {
    const b = body(req);
    return mutate(req, (s, me, t) =>
      core.sos(s, me, t, { location: geo(b.location, t), status: typeof b.status === 'string' ? b.status : undefined }),
    );
  });

  /** A preset status ("Call me", "Come find me") without a voice note. */
  app.post('/v1/status', async (req) => {
    const status = str(body(req).status, 'status', 120);
    return mutate(req, (s, me, t) => core.attachCard(s, me, bareCard(status, 'preset'), t));
  });

  /**
   * Voice note → open-weight transcription + grounded extraction → card.
   * The SOS itself was already sent by /v1/sos; this only adds detail.
   */
  app.post('/v1/voice', async (req) => {
    const a = authed(req);
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio?.length) throw new HttpError(400, 'no-audio', 'send the recording as an audio/* body');
    const preset = typeof (req.query as Record<string, unknown>).preset_status === 'string'
      ? String((req.query as Record<string, string>).preset_status).slice(0, 120)
      : null;
    let card: core.AlertCard;
    try {
      card = await makeCard({ audio, contentType: req.headers['content-type'] ?? null, presetStatus: preset });
    } catch (e) {
      log(`voice card failed: ${e instanceof Error ? e.message : e}`);
      card = bareCard(preset, 'ai-unavailable');
    }
    // Reload: the session may have changed while the model was running.
    const fresh = store.get(a.sessionId);
    if (!fresh) throw new HttpError(404, 'gone', 'this session no longer exists');
    return view(commit(core.attachCard(fresh, a.memberId, card, now())), a.memberId);
  });

  /** "My phone was near these friends' phones" — from Bluetooth, uploaded in batches. */
  app.post('/v1/proximity', async (req) => {
    const list = body(req).sightings;
    if (!Array.isArray(list)) throw new HttpError(400, 'bad-request', 'sightings must be an array');
    const sightings = list.slice(0, 100).map((x) => ({
      memberId: str((x as Record<string, unknown>)?.memberId, 'memberId', 64),
      at: num((x as Record<string, unknown>)?.at, 'at'),
    }));
    return mutate(req, (s, me, t) => core.reportSightings(s, me, sightings, t));
  });

  app.post('/v1/battery', async (req) => {
    const b = body(req);
    return mutate(req, (s, me, t) => core.reportBattery(s, me, num(b.level, 'level'), t, geo(b.location, t)));
  });

  for (const action of ['ack', 'escalate', 'resolve'] as const) {
    app.post(`/v1/members/:id/${action}`, async (req) => {
      const target = (req.params as { id: string }).id;
      return mutate(req, (s, me, t) =>
        action === 'ack' ? core.acknowledge(s, me, target, t)
        : action === 'escalate' ? core.escalate(s, me, target, t)
        : core.resolve(s, me, target, t),
      );
    });
  }

  app.put('/v1/policy', async (req) => mutate(req, (s, me, t) => core.updatePolicy(s, me, policy(body(req).policy)!, t)));

  app.put('/v1/push-token', async (req) => {
    const a = authed(req);
    const token = str(body(req).token, 'token', 200);
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) throw new HttpError(400, 'bad-token', 'expected an Expo push token');
    store.setPushToken(a, token);
    return { ok: true };
  });

  app.post('/v1/leave', async (req) => mutate(req, (s, me, t) => core.leave(s, me, t)));

  app.get('/v1/live', { websocket: true }, (socket, req) => {
    let a: ReturnType<typeof authed>;
    try {
      a = authed(req, (req.query as Record<string, string>).token);
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const entry = { ws: socket, memberId: a.memberId };
    const set = live.get(a.sessionId) ?? new Set();
    set.add(entry);
    live.set(a.sessionId, set);
    socket.send(JSON.stringify({ type: 'view', view: view(a.session, a.memberId) }));
    socket.on('close', () => {
      set.delete(entry);
      if (!set.size) live.delete(a.sessionId);
    });
  });

  /** Advance every session whose next stage change is due. */
  function runDue() {
    const t = now();
    for (const id of store.due(t)) {
      const s = store.get(id);
      if (s) commit(core.tick(s, t));
    }
  }

  /** Wait for in-flight notifications (tests, graceful shutdown). */
  async function idle() {
    while (pending.size) await Promise.all([...pending]);
  }

  return { app, runDue, idle };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function body(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as Record<string, unknown>) : {};
}

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'bad-request', `${name} is required`);
  return v.trim().slice(0, max);
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 20) : undefined;
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'bad-request', `${name} must be a number`);
  return v;
}

function policy(v: unknown): CheckInPolicy | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object') throw new HttpError(400, 'bad-request', 'policy must be an object');
  return { ...core.DEFAULT_POLICY, ...(v as Partial<CheckInPolicy>) };
}

/** Accept a phone fix; the server stamps the time if the client's clock looks wrong. */
function geo(v: unknown, t: number): GeoFix | undefined {
  if (v === undefined || v === null) return undefined;
  const g = v as Partial<GeoFix>;
  if (typeof g.lat !== 'number' || typeof g.lng !== 'number' || Math.abs(g.lat) > 90 || Math.abs(g.lng) > 180)
    throw new HttpError(400, 'bad-request', 'location needs lat and lng');
  const at = typeof g.at === 'number' && g.at <= t + 60_000 && g.at > t - 6 * 3600_000 ? g.at : t;
  return { lat: g.lat, lng: g.lng, accuracyM: typeof g.accuracyM === 'number' ? g.accuracyM : undefined, at };
}

/** Fixed-window limiter, per key per minute. Enough to stop join-code guessing. */
function rateLimiter() {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, perMinute: number) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < t) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { n: 1, reset: t + 60_000 });
      return true;
    }
    return ++h.n <= perMinute;
  };
}

export type Huddle = Awaited<ReturnType<typeof buildApp>>;
