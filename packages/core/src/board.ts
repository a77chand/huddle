import { lastNear, needsAttention } from './engine.ts';
import type { AlertCard, GeoFix, Member, Millis, Responder, Sealed, Session } from './types.ts';

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
  /** Plain location (unencrypted huddles, or after the phone decrypts `sealedLocation`). */
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
  /** Emergency contacts outside the app exist / have been texted. */
  hasContacts: boolean;
  contactsAlerted: boolean;
  /** Encrypted huddles: ciphertexts only members can open. */
  sealedLocation: Sealed | null;
  sealedCard: Sealed | null;
  sealedStatus: string | null;
  publicKey: string | null;
}

export interface Board {
  sessionId: string;
  name: string;
  timeZone: string;
  endsAt: Millis;
  ended: boolean;
  e2e: boolean;
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
    e2e: session.e2e === true,
    rows,
    counts: {
      present: present.length,
      accountedFor: present.length - attention.length,
      needAttention: attention.length,
      beingHelped: attention.filter((r) => r.responders.length > 0).length,
    },
  };
}

export function row(session: Session, m: Member, now: Millis): BoardRow {
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
    locationStale: isStale(m.lastLocation?.at ?? m.sealedLocation?.at, now),
    liveLocation: m.liveLocationSince !== null,
    lastNear: near && { ...near, name: session.members.find((x) => x.id === near.memberId)?.name ?? 'a friend' },
    battery: m.battery,
    lowBattery: m.lowBatteryAlerted,
    responders: m.responders,
    sos: m.sos && { at: m.sos.at, status: m.sos.status },
    card: m.card,
    needsAttention: needsAttention(m),
    hasContacts: m.policy.contacts.length > 0,
    contactsAlerted: m.contactsAlertedAt !== null,
    sealedLocation: m.sealedLocation ?? null,
    sealedCard: m.sealedCard ?? null,
    sealedStatus: m.sos?.sealedStatus ?? null,
    publicKey: m.publicKey ?? null,
  };
}

export function isStale(at: Millis | undefined, now: Millis): boolean {
  return at !== undefined && now - at > STALE_LOCATION_MIN * MIN;
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

/**
 * Server-side incident. For emergency texts in an encrypted huddle, only the
 * location the member chose to share with their contacts is used.
 */
export function incident(session: Session, memberId: string, now: Millis, opts: { forContacts?: boolean } = {}): Incident | null {
  const m = session.members.find((x) => x.id === memberId);
  if (!m) return null;
  const r = row(session, m, now);
  if (opts.forContacts && session.e2e) {
    r.lastLocation = m.contactLocation ?? null;
    r.locationStale = isStale(m.contactLocation?.at, now);
  }
  return incidentFromRow(r, board(session, now).rows, session.timeZone, now, opts.forContacts ? 'contacts' : 'group');
}

/** Pure, row-based incident: used by the server, and by phones after decrypting a row. */
export function incidentFromRow(
  r: BoardRow,
  rows: BoardRow[],
  timeZone: string,
  now: Millis,
  audience: 'group' | 'contacts' = 'group',
): Incident | null {
  // Encrypted details: members open them in the app; contacts outside it can only ask the group.
  const where = audience === 'group' ? 'visible in the Huddle app' : 'ask their friends in the huddle';
  if (!r.needsAttention) return null;
  const clock = clockFormatter(timeZone);
  const ago = (t: Millis) => {
    const min = Math.max(0, Math.round((now - t) / MIN));
    return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
  };
  const nameOf = (id: string) => rows.find((x) => x.id === id)?.name ?? 'someone';
  const missed = r.status === 'overdue' || r.status === 'escalated';
  const loc = r.lastLocation;
  const card = r.card;

  const headline =
    r.status === 'sos' ? `${r.name} asked for help`
    : missed ? `${r.name} missed a check-in — unreachable, not confirmed in danger`
    : `${r.name}'s phone is almost out of battery`;

  const known: string[] = [];
  if (r.sos) known.push(`SOS sent at ${clock(r.sos.at)} (${ago(r.sos.at)})${r.sos.status ? `: "${r.sos.status}"` : ''}.`);
  known.push(`Last check-in: ${clock(r.lastCheckInAt)} (${ago(r.lastCheckInAt)}).`);
  if (!r.sos && r.lateMin > 0) known.push(`Check-in was due at ${clock(r.nextDueAt)}; now ${r.lateMin} min late.`);
  if (loc)
    known.push(
      `Last shared location at ${clock(loc.at)} (${ago(loc.at)})` +
        (loc.accuracyM ? `, accurate to about ${Math.round(loc.accuracyM)} m` : '') +
        (r.liveLocation ? ', live sharing on' : '') +
        `: ${mapsLink(loc)}`,
    );
  else if (r.sealedLocation) known.push(`A location was shared at ${clock(r.sealedLocation.at)} (${ago(r.sealedLocation.at)}) — end-to-end encrypted, ${where}.`);
  if (r.lastNear)
    known.push(
      `Last near ${r.lastNear.name}'s phone at ${clock(r.lastNear.at)} (${ago(r.lastNear.at)}, Bluetooth)` +
        (r.lastNear.at > r.lastCheckInAt ? ' — after their last check-in.' : '.'),
    );
  if (r.battery) known.push(`Battery ${Math.round(r.battery.level * 100)}% at ${clock(r.battery.at)}.`);
  if (card) {
    if (card.presetStatus) known.push(`They chose: "${card.presetStatus}".`);
    for (const [label, f] of [
      ['They said they are', card.statedLocation],
      ['They asked', card.requestedAction],
      ['They asked you NOT to', card.avoid],
      ['They said about how they feel', card.condition],
      ['Preferred contact', card.contactPreference],
    ] as const) {
      if (f) known.push(`${label}: ${f.value} — their words: "${f.quote}".`);
    }
  } else if (r.sealedCard) known.push(`They sent details at ${clock(r.sealedCard.at)} — end-to-end encrypted, ${where}.`);
  if (r.contactsAlerted) known.push(`Their emergency contacts have been texted.`);
  for (const resp of r.responders) known.push(`${nameOf(resp.memberId)} is responding (since ${clock(resp.at)}).`);

  const unknown: string[] = [];
  if (!r.sos && missed) unknown.push('Why they missed it — a dead battery, no signal, a loud venue, or being busy are all common.');
  if (!loc && !r.sealedLocation) unknown.push('Where they are — no location has been shared.');
  else if (r.locationStale) unknown.push('Whether they are still at the last shared location — it is over 15 minutes old.');
  if (r.sos && !card && !r.sealedCard) unknown.push('Details — no voice note or status yet.');
  if (card && !card.statedLocation && loc) unknown.push('Exact spot — they did not describe where they are.');

  const nextSteps: string[] = [];
  if (card?.contactPreference) nextSteps.push(`Contact them the way they asked: ${card.contactPreference.value}.`);
  else nextSteps.push(`Call or text ${r.name} directly.`);
  if (card?.requestedAction) nextSteps.push(`Do what they asked: ${card.requestedAction.value}.`);
  if (card?.avoid) nextSteps.push(`Respect: do not ${card.avoid.value}.`);
  if (r.responders.length === 0) nextSteps.push(`Tap "I'm on it" so the group knows someone is handling this.`);
  if (loc && !card?.avoid) nextSteps.push(`If you can't reach them, head to the last shared location.`);
  if (!r.sos)
    nextSteps.push(r.lastNear ? `Ask ${r.lastNear.name} — their phone was last near ${r.name}'s.` : `Ask whoever was last with ${r.name}.`);
  if (!r.contactsAlerted && r.hasContacts) nextSteps.push(`If you still can't reach them, tap "Text their contacts".`);
  nextSteps.push('If you believe there is immediate danger, call local emergency services.');

  return { memberId: r.id, name: r.name, headline, known, unknown, nextSteps };
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
