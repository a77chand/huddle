import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import * as core from '@huddle/core';
import { HuddleError, type CheckInPolicy, type GeoFix, type Result, type Session } from '@huddle/core';
import { bareCard, type CardMaker } from './ai.ts';
import { render } from './messages.ts';
import { buildReport, toMarkdown } from './report.ts';
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
      // Only members ever see this (every view is authenticated). Encrypted huddles
      // derive it from the group key instead, so the server can't know it.
      proximityKey: session.endedAt === null && !session.e2e ? session.proximityKey : null,
      keys: session.e2e ? keyState(session, memberId) : null,
      board: b,
      incidents: b.rows.filter((r) => r.needsAttention).map((r) => core.incident(session, r.id, t)!),
      timeline: session.timeline.slice(-50),
    };
  }

  /** What this member needs for E2E: their wrapped keys, and who still needs the current key. */
  function keyState(session: Session, memberId: string) {
    const epoch = session.keyEpoch ?? 1;
    const wrapped = store.wrappedMembers(session.id, epoch);
    return {
      epoch,
      claimed: wrapped.size > 0,
      mine: store.wrapsFor(session.id, memberId),
      needWrap: session.members
        .filter((m) => m.leftAt === null && m.publicKey && !wrapped.has(m.id))
        .map((m) => ({ memberId: m.id, publicKey: m.publicKey! })),
    };
  }

  function broadcast(session: Session) {
    for (const c of live.get(session.id) ?? []) {
      if (session.members.find((m) => m.id === c.memberId)?.leftAt != null) {
        c.ws.close(4403, 'left');
        continue;
      }
      try {
        c.ws.send(JSON.stringify({ type: 'view', view: view(session, c.memberId) }));
      } catch {
        /* closed socket; cleaned up on 'close' */
      }
    }
  }

  /**
   * Persist a result, then notify phones and contacts. Delivery never delays the response.
   * `dueAt` is when the event should have happened (for the field-test latency report).
   */
  function commit(r: Result, dueFor: (memberId: string, kind: string) => number = () => now()) {
    store.save(r.session);
    broadcast(r.session);
    if (r.effects.length) {
      const out = render(r.session, r.effects, now());
      const p = deliver(sender, store.pushTokens(r.session.id), out, log, (d) =>
        store.logDelivery({
          sessionId: d.message.data.sessionId,
          memberId: d.message.data.memberId,
          kind: d.message.channel === 'push' ? `${d.message.data.kind}:${d.message.urgency}` : d.message.data.kind,
          channel: d.message.channel,
          recipients: d.recipients,
          dueAt: dueFor(d.message.data.memberId, d.message.data.kind),
          sentAt: Math.max(now(), dueFor(d.message.data.memberId, d.message.data.kind)),
          ok: d.ok,
        }),
      ).finally(() => pending.delete(p));
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
    // Someone who left keeps nothing: not the board, not new ciphertext, not the live feed.
    if (session.members.find((m) => m.id === auth.memberId)?.leftAt != null) throw new HttpError(403, 'left', 'you left this huddle');
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
      e2e: b.e2e === true,
      founder: { id: memberId, name: str(b.memberName, 'memberName', 40), phone: optStr(b.phone), publicKey: optKey(b.publicKey), policy: policy(b.policy) },
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
      core.join(
        found,
        { id: memberId, name: str(b.memberName, 'memberName', 40), phone: optStr(b.phone), publicKey: optKey(b.publicKey), policy: policy(b.policy) },
        now(),
      ),
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
      core.checkIn(s, me, t, { ...locations(b, t), battery: b.battery === undefined ? undefined : num(b.battery, 'battery') }),
    );
  });

  app.post('/v1/snooze', async (req) => mutate(req, (s, me, t) => core.snooze(s, me, num(body(req).minutes, 'minutes'), t)));

  app.post('/v1/sos', async (req) => {
    const b = body(req);
    return mutate(req, (s, me, t) =>
      core.sos(s, me, t, {
        ...locations(b, t),
        status: typeof b.status === 'string' ? b.status : undefined,
        sealedStatus: typeof b.sealedStatus === 'string' ? b.sealedStatus : undefined,
      }),
    );
  });

  /** A preset status ("Call me", "Come find me") without a voice note. */
  app.post('/v1/status', async (req) => {
    const status = str(body(req).status, 'status', 120);
    return mutate(req, (s, me, t) => {
      if (s.e2e) throw new HttpError(400, 'encrypted', 'this huddle is encrypted; send the status sealed to /v1/card-sealed');
      return core.attachCard(s, me, bareCard(status, 'preset'), t);
    });
  });

  /** Encrypted huddles: a voice card or status sealed on the phone. The server can't read it. */
  app.post('/v1/card-sealed', async (req) => {
    const blob = str(body(req).blob, 'blob', 8192);
    return mutate(req, (s, me, t) => core.attachSealedCard(s, me, blob, t));
  });

  /**
   * Group keys sealed to members' public keys. The first upload for an epoch
   * claims it (and must include the uploader); later uploads come from members
   * who already hold that epoch, for people who joined since.
   */
  app.post('/v1/keys', async (req) => {
    const a = authed(req);
    const s = a.session;
    if (!s.e2e) throw new HttpError(400, 'not-e2e', 'this huddle is not encrypted');
    const b = body(req);
    const epoch = num(b.epoch, 'epoch');
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > (s.keyEpoch ?? 1)) throw new HttpError(400, 'bad-epoch', 'unknown key epoch');
    const list = Array.isArray(b.wraps) ? b.wraps.slice(0, 25) : [];
    const wraps = list.map((x) => {
      const w = (x ?? {}) as Record<string, unknown>;
      const memberId = str(w.memberId, 'memberId', 64);
      const blob = str(w.blob, 'blob', 512);
      const m = s.members.find((x) => x.id === memberId);
      if (!m || m.leftAt !== null || !m.publicKey) throw new HttpError(400, 'bad-member', 'wraps are only for current members');
      if (!/^w1\.[A-Za-z0-9_-]+$/.test(blob)) throw new HttpError(400, 'bad-wrap', 'expected a wrapped key');
      return { memberId, blob };
    });
    if (!wraps.length) throw new HttpError(400, 'bad-request', 'no wraps');
    // The server can't check who really holds a key. It records holders by their own wrap: a
    // member not yet recorded (e.g. joined by invite link) must include theirs, which also
    // means the first upload for an epoch claims it. Wraps never overwrite existing ones.
    const holders = store.wrappedMembers(s.id, epoch);
    if (!holders.has(a.memberId) && !wraps.some((w) => w.memberId === a.memberId))
      throw new HttpError(holders.size === 0 ? 400 : 403, holders.size === 0 ? 'claim-needs-self' : 'not-holder', 'include a wrap for yourself');
    if (!store.putWraps(s.id, a.memberId, epoch, wraps)) throw new HttpError(409, 'already-wrapped', 'another phone already shared this key');
    broadcast(s);
    return view(s, a.memberId);
  });

  /**
   * Voice note → open-weight transcription + grounded extraction → card.
   * The SOS itself was already sent by /v1/sos; this only adds detail.
   */
  app.post('/v1/voice', async (req) => {
    const a = authed(req);
    const ephemeral = (req.query as Record<string, string>).ephemeral === '1' || a.session.e2e === true;
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
    // Encrypted huddles: return the card to the phone, which seals it. Nothing is stored here.
    if (ephemeral) return { card };
    // Reload: the session may have changed while the model was running.
    const fresh = store.get(a.sessionId);
    if (!fresh) throw new HttpError(404, 'gone', 'this session no longer exists');
    return view(commit(core.attachCard(fresh, a.memberId, card, now())), a.memberId);
  });

  /** Opt-in live location: background updates, or turning sharing off ({ live: false }). */
  app.post('/v1/location', async (req) => {
    const b = body(req);
    if (typeof b.live !== 'boolean') throw new HttpError(400, 'bad-request', 'live must be true or false');
    return mutate(req, (s, me, t) => core.shareLocation(s, me, { live: b.live as boolean, ...locations(b, t) }, t));
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

  /**
   * A card made on the phone (on-device Whisper + fine-tuned model). Re-grounded
   * here with the same rule as the server's AI service: unquoted fields are dropped.
   */
  app.post('/v1/card', async (req) => {
    const b = body(req);
    const transcript = typeof b.transcript === 'string' ? b.transcript.slice(0, 2000) : '';
    const fields = b.fields && typeof b.fields === 'object' ? (b.fields as Record<string, unknown>) : {};
    const extractor = `on-device:${typeof b.extractor === 'string' ? b.extractor.slice(0, 60) : 'unknown'}`;
    const preset = typeof b.presetStatus === 'string' ? b.presetStatus.slice(0, 120) : null;
    const { card } = core.groundCard(transcript, fields as never, extractor, preset);
    return mutate(req, (s, me, t) => {
      if (s.e2e) throw new HttpError(400, 'encrypted', 'this huddle is encrypted; seal the card and use /v1/card-sealed');
      return core.attachCard(s, me, card, t);
    });
  });

  /** Opt-in field-test samples from the phone: battery and radio state. */
  app.post('/v1/diagnostics', async (req) => {
    const a = authed(req);
    const list = body(req).samples;
    if (!Array.isArray(list)) throw new HttpError(400, 'bad-request', 'samples must be an array');
    const t = now();
    const samples = list.slice(0, 100).flatMap((x) => {
      const s = (x ?? {}) as Record<string, unknown>;
      const at = typeof s.at === 'number' && s.at <= t + 60_000 && s.at > t - 24 * 3600_000 ? s.at : null;
      if (at === null) return [];
      const battery = typeof s.battery === 'number' && s.battery >= 0 && s.battery <= 1 ? s.battery : null;
      const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 32) : null);
      return [{
        at,
        battery,
        lowPower: s.lowPower === true,
        charging: s.charging === true,
        proximity: short(s.proximity),
        liveLocation: short(s.liveLocation),
        appState: short(s.appState),
        sightings: typeof s.sightings === 'number' ? Math.max(0, Math.floor(s.sightings)) : null,
      }];
    });
    store.addDiagnostics(a, samples);
    return { stored: samples.length };
  });

  /** Field-test report for this session (JSON, or Markdown with ?format=md). */
  app.get('/v1/report', async (req, reply) => {
    const a = authed(req);
    const r = buildReport(a.session, store.deliveries(a.sessionId), store.diagnostics(a.sessionId));
    if ((req.query as Record<string, string>).format === 'md') return reply.type('text/markdown').send(toMarkdown(r));
    return r;
  });

  app.post('/v1/battery', async (req) => {
    const b = body(req);
    return mutate(req, (s, me, t) => core.reportBattery(s, me, num(b.level, 'level'), t, locations(b, t)));
  });

  app.post('/v1/members/:id/remove', async (req) => {
    const target = (req.params as { id: string }).id;
    return mutate(req, (s, me, t) => core.removeMember(s, me, target, t));
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
      if (!s) continue;
      // Due = the threshold that fired (from the state before the tick), so the report includes scheduler lag.
      commit(core.tick(s, t), (memberId, kind) => {
        const m = s.members.find((x) => x.id === memberId);
        const due = m ? core.alertDueAt(m, kind as core.Effect['kind']) : null;
        return due !== null && due <= t ? due : t;
      });
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

/** A plain location and/or a sealed one ({ blob, at }) from a request body. */
function locations(b: Record<string, unknown>, t: number): core.LocationInput {
  const out: core.LocationInput = { location: geo(b.location, t) };
  const s = b.sealedLocation as { blob?: unknown; at?: unknown } | undefined;
  if (s && typeof s === 'object') {
    if (typeof s.blob !== 'string') throw new HttpError(400, 'bad-request', 'sealedLocation needs blob and at');
    const at = typeof s.at === 'number' && s.at <= t + 60_000 && s.at > t - 6 * 3600_000 ? s.at : t;
    out.sealedLocation = { blob: s.blob, at };
  }
  return out;
}

function optKey(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) throw new HttpError(400, 'bad-key', 'publicKey must be a base64url X25519 key');
  return v;
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
