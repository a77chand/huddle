import type {
  AlertCard,
  CheckInPolicy,
  Effect,
  GeoFix,
  Member,
  Millis,
  Result,
  Session,
  Stage,
  TimelineEntry,
  TimelineKind,
} from './types.ts';

const MIN = 60_000;
const STAGES: Stage[] = ['ok', 'due', 'nudged', 'overdue', 'escalated'];
const LOW_BATTERY = 0.05;
const BATTERY_RECOVERED = 0.2;
const E164 = /^\+[1-9]\d{6,14}$/;

export const DEFAULT_POLICY: CheckInPolicy = {
  intervalMin: 30,
  graceMin: 10,
  escalateAfterMin: 20,
  contacts: [],
  sosNotifiesContacts: true,
};

export class HuddleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validatePolicy(p: CheckInPolicy): CheckInPolicy {
  const whole = (n: unknown, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
  if (!whole(p.intervalMin, 5, 24 * 60)) throw new HuddleError('bad-policy', 'intervalMin must be 5..1440');
  if (!whole(p.graceMin, 1, 120)) throw new HuddleError('bad-policy', 'graceMin must be 1..120');
  if (p.escalateAfterMin !== null && !whole(p.escalateAfterMin, 1, 24 * 60))
    throw new HuddleError('bad-policy', 'escalateAfterMin must be 1..1440 or null');
  if (!Array.isArray(p.contacts) || p.contacts.length > 5)
    throw new HuddleError('bad-policy', 'at most 5 contacts');
  for (const c of p.contacts) {
    if (!c || typeof c.name !== 'string' || !E164.test(c.phone ?? ''))
      throw new HuddleError('bad-policy', 'contacts need a name and an E.164 phone like +14155550123');
  }
  return {
    intervalMin: p.intervalMin,
    graceMin: p.graceMin,
    escalateAfterMin: p.escalateAfterMin,
    contacts: p.contacts.map((c) => ({ name: c.name.slice(0, 60), phone: c.phone })),
    sosNotifiesContacts: Boolean(p.sosNotifiesContacts),
  };
}

export function createSession(opts: {
  id: string;
  name: string;
  now: Millis;
  durationHours?: number;
  timeZone?: string;
  /** 32 hex chars of randomness from the host (the engine stays deterministic). */
  proximityKey: string;
  founder: { id: string; name: string; phone?: string; policy?: CheckInPolicy };
}): Result {
  const hours = opts.durationHours ?? 12;
  if (!(hours > 0 && hours <= 48)) throw new HuddleError('bad-duration', 'durationHours must be 0..48');
  const session: Session = {
    id: opts.id,
    name: opts.name.slice(0, 80),
    timeZone: validZone(opts.timeZone),
    proximityKey: opts.proximityKey,
    createdAt: opts.now,
    endsAt: opts.now + hours * 60 * MIN,
    endedAt: null,
    members: [],
    timeline: [],
  };
  return join(session, opts.founder, opts.now);
}

export function join(
  session: Session,
  m: { id: string; name: string; phone?: string; policy?: CheckInPolicy },
  now: Millis,
): Result {
  const s = open(session);
  if (s.members.some((x) => x.id === m.id)) throw new HuddleError('exists', 'already a member');
  if (s.members.filter((x) => x.leftAt === null).length >= 20)
    throw new HuddleError('full', 'a session holds at most 20 people');
  const policy = validatePolicy(m.policy ?? DEFAULT_POLICY);
  if (m.phone && !E164.test(m.phone)) throw new HuddleError('bad-phone', 'phone must be E.164, like +14155550123');
  s.members.push({
    id: m.id,
    name: m.name.slice(0, 40),
    phone: m.phone || null,
    joinedAt: now,
    policy,
    lastCheckInAt: now,
    nextDueAt: now + policy.intervalMin * MIN,
    lastLocation: null,
    battery: null,
    stage: 'ok',
    stageSince: now,
    sos: null,
    card: null,
    responders: [],
    lowBatteryAlerted: false,
    contactsAlertedAt: null,
    seenNear: {},
    liveLocationSince: null,
    leftAt: null,
  });
  log(s, { at: now, kind: 'joined', memberId: m.id });
  return { session: s, effects: [] };
}

/** Routine "I'm okay". Resets the ladder; an active SOS needs an explicit resolve. */
export function checkIn(
  session: Session,
  memberId: string,
  now: Millis,
  extra: { location?: GeoFix; battery?: number } = {},
): Result {
  const s = open(session);
  const m = active(s, memberId);
  const effects: Effect[] = [];
  const wasAlerted = isGroupAlerted(m.stage);
  m.lastCheckInAt = now;
  m.nextDueAt = now + m.policy.intervalMin * MIN;
  setStage(m, 'ok', now);
  if (extra.location) m.lastLocation = extra.location;
  log(s, { at: now, kind: 'check-in', memberId });
  if (wasAlerted && !m.sos) {
    m.responders = [];
    m.card = null;
    effects.push(allClear(m, memberId));
  }
  if (extra.battery !== undefined) effects.push(...battery(s, m, extra.battery, now));
  return { session: s, effects };
}

/** Push the next check-in out, e.g. "I'm in the cinema for 2 hours". */
export function snooze(session: Session, memberId: string, minutes: number, now: Millis): Result {
  const s = open(session);
  const m = active(s, memberId);
  if (!(minutes >= 5 && minutes <= 240)) throw new HuddleError('bad-snooze', 'snooze 5..240 minutes');
  if (m.sos) throw new HuddleError('sos-active', 'resolve the SOS first');
  if (isGroupAlerted(m.stage)) throw new HuddleError('alerted', 'check in instead; your group was already told');
  m.nextDueAt = now + minutes * MIN;
  setStage(m, 'ok', now);
  log(s, { at: now, kind: 'snoozed', memberId, detail: `${minutes} min` });
  return { session: s, effects: [] };
}

export function sos(
  session: Session,
  memberId: string,
  now: Millis,
  extra: { location?: GeoFix; status?: string } = {},
): Result {
  const s = open(session);
  const m = active(s, memberId);
  if (extra.location) m.lastLocation = extra.location;
  const status = extra.status?.slice(0, 120) ?? null;
  log(s, { at: now, kind: 'sos', memberId, detail: status ?? undefined });
  if (m.sos) {
    m.sos.status = status ?? m.sos.status;
    return { session: s, effects: [{ kind: 'group-alert', memberId, reason: 'sos-update' }] };
  }
  m.sos = { at: now, status };
  const effects: Effect[] = [{ kind: 'group-alert', memberId, reason: 'sos' }];
  if (m.policy.sosNotifiesContacts && m.policy.contacts.length > 0) {
    m.contactsAlertedAt = now;
    effects.push({ kind: 'contacts-alert', memberId, reason: 'sos' });
  }
  return { session: s, effects };
}

/** Attach the structured voice-note / status card produced by the AI service. */
export function attachCard(session: Session, memberId: string, card: AlertCard, now: Millis): Result {
  const s = open(session);
  const m = active(s, memberId);
  m.card = card;
  log(s, { at: now, kind: 'card', memberId, detail: card.requestedAction?.value ?? card.presetStatus ?? undefined });
  return { session: s, effects: [{ kind: 'card', memberId }] };
}

/** "I'm on it" — tells the rest of the group someone is responding. */
export function acknowledge(session: Session, responderId: string, targetId: string, now: Millis): Result {
  const s = open(session);
  active(s, responderId);
  const t = active(s, targetId);
  if (responderId === targetId) throw new HuddleError('self', 'you cannot respond to yourself');
  if (!needsAttention(t)) throw new HuddleError('not-needed', `${t.name} is not overdue or asking for help`);
  if (t.responders.some((r) => r.memberId === responderId)) return { session: s, effects: [] };
  t.responders.push({ memberId: responderId, at: now });
  log(s, { at: now, kind: 'ack', memberId: targetId, byId: responderId });
  return { session: s, effects: [{ kind: 'responder', memberId: targetId, responderId }] };
}

/** A person decides to text the member's external contacts now. */
export function escalate(session: Session, byId: string, targetId: string, now: Millis): Result {
  const s = open(session);
  active(s, byId);
  const t = active(s, targetId);
  if (!needsAttention(t)) throw new HuddleError('not-needed', `${t.name} is not overdue or asking for help`);
  if (t.policy.contacts.length === 0) throw new HuddleError('no-contacts', `${t.name} has no emergency contacts`);
  if (!t.sos) setStage(t, 'escalated', now);
  t.contactsAlertedAt = now;
  log(s, { at: now, kind: 'escalated', memberId: targetId, byId, detail: 'manual' });
  return { session: s, effects: [{ kind: 'contacts-alert', memberId: targetId, reason: 'manual' }] };
}

/** "Safe now" — by the member, or by a friend who found them. */
export function resolve(session: Session, byId: string, targetId: string, now: Millis): Result {
  const s = open(session);
  active(s, byId);
  const t = active(s, targetId);
  if (!needsAttention(t) && t.stage === 'ok') return { session: s, effects: [] };
  t.sos = null;
  t.card = null;
  t.responders = [];
  t.lastCheckInAt = now;
  t.nextDueAt = now + t.policy.intervalMin * MIN;
  setStage(t, 'ok', now);
  log(s, { at: now, kind: 'resolved', memberId: targetId, byId: byId === targetId ? undefined : byId });
  return { session: s, effects: [allClear(t, byId)] };
}

export function reportBattery(session: Session, memberId: string, level: number, now: Millis, location?: GeoFix): Result {
  const s = open(session);
  const m = active(s, memberId);
  if (location) m.lastLocation = location;
  return { session: s, effects: battery(s, m, level, now) };
}

/**
 * "My phone was near these friends' phones." Recorded on both sides: if Ana's
 * phone saw Cy's, they were near each other. Information only — being near a
 * friend is not a check-in.
 */
export function reportSightings(
  session: Session,
  observerId: string,
  sightings: { memberId: string; at: Millis }[],
  now: Millis,
): Result {
  const s = open(session);
  const observer = active(s, observerId);
  if (sightings.length > 100) throw new HuddleError('too-many', 'at most 100 sightings per report');
  for (const { memberId, at } of sightings) {
    const other = s.members.find((m) => m.id === memberId);
    // Ignore unknown ids, self, people who left, and clocks that are far off.
    if (!other || other.id === observerId || other.leftAt !== null) continue;
    if (!(at <= now + MIN && at >= Math.max(now - 12 * 60 * MIN, other.joinedAt, observer.joinedAt))) continue;
    observer.seenNear ??= {};
    other.seenNear ??= {};
    observer.seenNear[other.id] = Math.max(observer.seenNear[other.id] ?? 0, at);
    other.seenNear[observer.id] = Math.max(other.seenNear[observer.id] ?? 0, at);
  }
  return { session: s, effects: [] };
}

/**
 * Opt-in live location: a background update, or turning sharing on/off.
 * Updates the shared position only — it is not a check-in.
 */
export function shareLocation(
  session: Session,
  memberId: string,
  update: { live: boolean; location?: GeoFix },
  now: Millis,
): Result {
  const s = open(session);
  const m = active(s, memberId);
  if (update.location && (!m.lastLocation || update.location.at >= m.lastLocation.at)) m.lastLocation = update.location;
  m.liveLocationSince = update.live ? (m.liveLocationSince ?? now) : null;
  return { session: s, effects: [] };
}

/** The friend whose phone was most recently near this member's, if any. */
export function lastNear(session: Session, memberId: string): { memberId: string; at: Millis } | null {
  const m = session.members.find((x) => x.id === memberId);
  let best: { memberId: string; at: Millis } | null = null;
  for (const [id, at] of Object.entries(m?.seenNear ?? {})) if (!best || at > best.at) best = { memberId: id, at };
  return best;
}

export function updatePolicy(session: Session, memberId: string, policy: CheckInPolicy, now: Millis): Result {
  const s = open(session);
  const m = active(s, memberId);
  m.policy = validatePolicy(policy);
  if (m.stage === 'ok') m.nextDueAt = Math.max(now, m.lastCheckInAt + m.policy.intervalMin * MIN);
  return { session: s, effects: [] };
}

export function leave(session: Session, memberId: string, now: Millis): Result {
  const s = open(session);
  const m = active(s, memberId);
  m.leftAt = now;
  m.lastLocation = null;
  m.liveLocationSince = null;
  log(s, { at: now, kind: 'left', memberId });
  return { session: s, effects: [{ kind: 'left', memberId }] };
}

/**
 * Advance every member along the missed-check-in ladder. Call this on a timer;
 * it is idempotent — each stage's effects fire once.
 */
export function tick(session: Session, now: Millis): Result {
  const s = structuredClone(session);
  const effects: Effect[] = [];
  if (s.endedAt !== null) return { session: s, effects };
  if (now >= s.endsAt) {
    s.endedAt = now;
    for (const m of s.members) m.lastLocation = null;
    log(s, { at: now, kind: 'ended', memberId: '' });
    return { session: s, effects };
  }
  for (const m of s.members) {
    if (m.leftAt !== null || m.sos) continue;
    const target = stageAt(m, now);
    const from = STAGES.indexOf(m.stage);
    const to = STAGES.indexOf(target);
    if (to <= from) continue;
    for (let i = from + 1; i <= to; i++) {
      const stage = STAGES[i]!;
      // Skip prompts the member can no longer usefully answer before the group hears.
      if ((stage === 'due' || stage === 'nudged') && i !== to) continue;
      if (stage === 'due') effects.push({ kind: 'prompt', memberId: m.id, loud: false });
      if (stage === 'nudged') effects.push({ kind: 'prompt', memberId: m.id, loud: true });
      if (stage === 'overdue') effects.push({ kind: 'group-alert', memberId: m.id, reason: 'overdue' });
      if (stage === 'escalated') {
        m.contactsAlertedAt = now;
        effects.push({ kind: 'contacts-alert', memberId: m.id, reason: 'overdue' });
      }
      const kind: TimelineKind = stage === 'due' ? 'prompt' : stage === 'nudged' ? 'nudge' : stage === 'overdue' ? 'overdue' : 'escalated';
      log(s, { at: now, kind, memberId: m.id });
    }
    setStage(m, target, now);
  }
  return { session: s, effects };
}

/** The stage the clock says a member should be in (ignores SOS). */
export function stageAt(m: Member, now: Millis): Stage {
  const due = m.nextDueAt;
  const grace = m.policy.graceMin * MIN;
  if (now < due) return 'ok';
  if (now < due + grace / 2) return 'due';
  if (now < due + grace) return 'nudged';
  const esc = m.policy.escalateAfterMin;
  // A friend saying "I'm on it" pauses automatic escalation; they can still escalate by hand.
  if (esc === null || m.policy.contacts.length === 0 || m.responders.length > 0 || now < due + grace + esc * MIN)
    return m.stage === 'escalated' ? 'escalated' : 'overdue';
  return 'escalated';
}

/** When the next stage change could happen — lets a host sleep precisely. */
export function nextWakeAt(session: Session): Millis | null {
  if (session.endedAt !== null) return null;
  let next = session.endsAt;
  for (const m of session.members) {
    if (m.leftAt !== null || m.sos) continue;
    const g = m.policy.graceMin * MIN;
    const marks = [m.nextDueAt, m.nextDueAt + g / 2, m.nextDueAt + g];
    if (m.policy.escalateAfterMin !== null) marks.push(m.nextDueAt + g + m.policy.escalateAfterMin * MIN);
    const upcoming = marks.filter((t) => STAGES.indexOf(stageAt(m, t)) > STAGES.indexOf(m.stage));
    if (upcoming.length) next = Math.min(next, ...upcoming);
  }
  return next;
}

export function needsAttention(m: Member): boolean {
  return m.leftAt === null && (m.sos !== null || isGroupAlerted(m.stage) || m.lowBatteryAlerted);
}

function allClear(m: Member, byId: string): Effect {
  const notifyContacts = m.contactsAlertedAt !== null;
  m.contactsAlertedAt = null;
  return { kind: 'all-clear', memberId: m.id, byId, notifyContacts };
}

function isGroupAlerted(stage: Stage) {
  return stage === 'overdue' || stage === 'escalated';
}

function battery(s: Session, m: Member, level: number, now: Millis): Effect[] {
  if (!(level >= 0 && level <= 1)) throw new HuddleError('bad-battery', 'battery level is 0..1');
  m.battery = { level, at: now };
  if (level >= BATTERY_RECOVERED) m.lowBatteryAlerted = false;
  if (level > LOW_BATTERY || m.lowBatteryAlerted) return [];
  m.lowBatteryAlerted = true;
  log(s, { at: now, kind: 'battery-low', memberId: m.id, detail: `${Math.round(level * 100)}%` });
  return [{ kind: 'group-alert', memberId: m.id, reason: 'battery-low' }];
}

function setStage(m: Member, stage: Stage, now: Millis) {
  if (m.stage !== stage) {
    m.stage = stage;
    m.stageSince = now;
  }
}

function open(session: Session): Session {
  if (session.endedAt !== null) throw new HuddleError('ended', 'this session has ended');
  return structuredClone(session);
}

function active(s: Session, id: string): Member {
  const m = s.members.find((x) => x.id === id);
  if (!m) throw new HuddleError('no-member', 'not a member of this session');
  if (m.leftAt !== null) throw new HuddleError('left', `${m.name} has left this session`);
  return m;
}

function log(s: Session, e: TimelineEntry) {
  s.timeline.push(e);
  if (s.timeline.length > 2000) s.timeline.splice(0, s.timeline.length - 2000);
}

function validZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}
