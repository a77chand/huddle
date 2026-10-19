import { lastNear, needsAttention } from './engine.ts';
import type { AlertCard, GeoFix, Member, Millis, Responder, Session } from './types.ts';

const MIN = 60_000;
/** A location older than this is flagged as possibly stale. */
const STALE_LOCATION_MIN = 15;

export type Status = 'ok' | 'due' | 'overdue' | 'escalated' | 'sos' | 'left';

export interface BoardRow {
  id: string;
  name: string;
  phone: string | null;
  status: Status;
  lastCheckInAt: Millis;
  nextDueAt: Millis;
  /** Minutes past the check-in time (0 when not late). */
  lateMin: number;
  lastLocation: GeoFix | null;
  locationStale: boolean;
  /** Sharing location continuously (opt-in), not just at check-ins. */
  liveLocation: boolean;
  /** Most recent friend whose phone was near this one (Bluetooth). */
  lastNear: { memberId: string; name: string; at: Millis } | null;
  battery: { level: number; at: Millis } | null;
  lowBattery: boolean;
  responders: Responder[];
  sos: { at: Millis; status: string | null } | null;
  card: AlertCard | null;
  needsAttention: boolean;
}

export interface Board {
  sessionId: string;
  name: string;
  timeZone: string;
  endsAt: Millis;
  ended: boolean;
  rows: BoardRow[];
  counts: { present: number; accountedFor: number; needAttention: number; beingHelped: number };
}

export function board(session: Session, now: Millis): Board {
  const rows = session.members.map((m) => row(session, m, now));
  const present = rows.filter((r) => r.status !== 'left');
  const attention = present.filter((r) => r.needsAttention);
  return {
    sessionId: session.id,
    name: session.name,
    timeZone: session.timeZone,
    endsAt: session.endsAt,
    ended: session.endedAt !== null,
    rows,
    counts: {
      present: present.length,
      accountedFor: present.length - attention.length,
      needAttention: attention.length,
      beingHelped: attention.filter((r) => r.responders.length > 0).length,
    },
  };
}

function row(session: Session, m: Member, now: Millis): BoardRow {
  const near = lastNear(session, m.id);
  const status: Status =
    m.leftAt !== null ? 'left'
    : m.sos ? 'sos'
    : m.stage === 'escalated' ? 'escalated'
    : m.stage === 'overdue' ? 'overdue'
    : m.stage === 'due' || m.stage === 'nudged' ? 'due'
    : 'ok';
  return {
    id: m.id,
    name: m.name,
    phone: m.phone,
    status,
    lastCheckInAt: m.lastCheckInAt,
    nextDueAt: m.nextDueAt,
    lateMin: Math.max(0, Math.floor((now - m.nextDueAt) / MIN)),
    lastLocation: m.lastLocation,
    locationStale: m.lastLocation !== null && now - m.lastLocation.at > STALE_LOCATION_MIN * MIN,
    liveLocation: m.liveLocationSince !== null,
    lastNear: near && { ...near, name: session.members.find((x) => x.id === near.memberId)?.name ?? 'a friend' },
    battery: m.battery,
    lowBattery: m.lowBatteryAlerted,
    responders: m.responders,
    sos: m.sos,
    card: m.card,
    needsAttention: needsAttention(m),
  };
}

/**
 * What a responder needs: what is known (with times), what is NOT known, and
 * what to do next. Deliberately deterministic — no model decides whether
 * someone is in danger.
 */
export interface Incident {
  memberId: string;
  name: string;
  headline: string;
  known: string[];
  unknown: string[];
  nextSteps: string[];
}

export function incident(session: Session, memberId: string, now: Millis): Incident | null {
  const m = session.members.find((x) => x.id === memberId);
  if (!m || !needsAttention(m)) return null;
  const clock = clockFormatter(session.timeZone);
  const ago = (t: Millis) => {
    const min = Math.max(0, Math.round((now - t) / MIN));
    return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
  };
  const nameOf = (id: string) => session.members.find((x) => x.id === id)?.name ?? 'someone';
  const r = row(session, m, now);

  const headline =
    r.status === 'sos' ? `${m.name} asked for help`
    : r.status === 'overdue' || r.status === 'escalated' ? `${m.name} missed a check-in — unreachable, not confirmed in danger`
    : `${m.name}'s phone is almost out of battery`;

  const known: string[] = [];
  if (m.sos) known.push(`SOS sent at ${clock(m.sos.at)} (${ago(m.sos.at)})${m.sos.status ? `: "${m.sos.status}"` : ''}.`);
  known.push(`Last check-in: ${clock(m.lastCheckInAt)} (${ago(m.lastCheckInAt)}).`);
  if (!m.sos && r.lateMin > 0) known.push(`Check-in was due at ${clock(m.nextDueAt)}; now ${r.lateMin} min late.`);
  if (m.lastLocation)
    known.push(
      `Last shared location at ${clock(m.lastLocation.at)} (${ago(m.lastLocation.at)})` +
        (m.lastLocation.accuracyM ? `, accurate to about ${Math.round(m.lastLocation.accuracyM)} m` : '') +
        (m.liveLocationSince !== null ? ', live sharing on' : '') +
        `: ${mapsLink(m.lastLocation)}`,
    );
  if (r.lastNear)
    known.push(
      `Last near ${r.lastNear.name}'s phone at ${clock(r.lastNear.at)} (${ago(r.lastNear.at)}, Bluetooth)` +
        (r.lastNear.at > m.lastCheckInAt ? ' — after their last check-in.' : '.'),
    );
  if (m.battery) known.push(`Battery ${Math.round(m.battery.level * 100)}% at ${clock(m.battery.at)}.`);
  if (m.card) {
    const c = m.card;
    if (c.presetStatus) known.push(`They chose: "${c.presetStatus}".`);
    for (const [label, f] of [
      ['They said they are', c.statedLocation],
      ['They asked', c.requestedAction],
      ['They asked you NOT to', c.avoid],
      ['They said about how they feel', c.condition],
      ['Preferred contact', c.contactPreference],
    ] as const) {
      if (f) known.push(`${label}: ${f.value} — their words: "${f.quote}".`);
    }
  }
  if (m.stage === 'escalated') known.push(`Their emergency contacts have been texted.`);
  for (const resp of m.responders) known.push(`${nameOf(resp.memberId)} is responding (since ${clock(resp.at)}).`);

  const unknown: string[] = [];
  if (!m.sos && (m.stage === 'overdue' || m.stage === 'escalated'))
    unknown.push('Why they missed it — a dead battery, no signal, a loud venue, or being busy are all common.');
  if (!m.lastLocation) unknown.push('Where they are — no location has been shared.');
  else if (r.locationStale) unknown.push('Whether they are still at the last shared location — it is over 15 minutes old.');
  if (m.sos && !m.card) unknown.push('Details — no voice note or status yet.');
  if (m.card && !m.card.statedLocation && m.lastLocation) unknown.push('Exact spot — they did not describe where they are.');

  const nextSteps: string[] = [];
  if (m.card?.contactPreference) nextSteps.push(`Contact them the way they asked: ${m.card.contactPreference.value}.`);
  else nextSteps.push(`Call or text ${m.name} directly.`);
  if (m.card?.requestedAction) nextSteps.push(`Do what they asked: ${m.card.requestedAction.value}.`);
  if (m.card?.avoid) nextSteps.push(`Respect: do not ${m.card.avoid.value}.`);
  if (m.responders.length === 0) nextSteps.push(`Tap "I'm on it" so the group knows someone is handling this.`);
  if (m.lastLocation && !m.card?.avoid) nextSteps.push(`If you can't reach them, head to the last shared location.`);
  if (!m.sos)
    nextSteps.push(r.lastNear ? `Ask ${r.lastNear.name} — their phone was last near ${m.name}'s.` : `Ask whoever was last with ${m.name}.`);
  if (m.stage !== 'escalated' && m.policy.contacts.length > 0)
    nextSteps.push(`If you still can't reach them, tap "Text their contacts".`);
  nextSteps.push('If you believe there is immediate danger, call local emergency services.');

  return { memberId: m.id, name: m.name, headline, known, unknown, nextSteps };
}

/** Plain-text version for SMS to people without the app. */
export function incidentText(i: Incident, sessionName: string): string {
  return [
    `[Huddle · ${sessionName}] ${i.headline}`,
    ...i.known.map((k) => `• ${k}`),
    ...(i.unknown.length ? ['Not known:', ...i.unknown.map((u) => `• ${u}`)] : []),
    `Next: ${i.nextSteps[0]}`,
  ].join('\n');
}

export function mapsLink(g: GeoFix): string {
  return `https://maps.google.com/?q=${g.lat.toFixed(5)},${g.lng.toFixed(5)}`;
}

function clockFormatter(timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  return (t: Millis) => f.format(t);
}
