/** Epoch milliseconds. */
export type Millis = number;

export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM?: number;
  at: Millis;
}

/** Someone outside the app who is reached by SMS. */
export interface Contact {
  name: string;
  phone: string;
}

export interface CheckInPolicy {
  /** How often "Still okay?" is asked. */
  intervalMin: number;
  /** Private follow-up window after a missed check-in before the group is told. */
  graceMin: number;
  /**
   * Minutes after the group is told, with nobody responding, before external
   * contacts are texted. null = only a person can escalate.
   */
  escalateAfterMin: number | null;
  contacts: Contact[];
  /** An explicit SOS also texts external contacts immediately. */
  sosNotifiesContacts: boolean;
}

/**
 * Where a member is on the missed-check-in ladder.
 * ok -> due (prompt) -> nudged (louder prompt) -> overdue (group told) -> escalated (contacts texted)
 */
export type Stage = 'ok' | 'due' | 'nudged' | 'overdue' | 'escalated';

/**
 * What the person said, structured by the AI service. Every field carries the
 * exact words it came from; anything not said is absent, never guessed.
 */
export interface GroundedField {
  value: string;
  quote: string;
}

export interface AlertCard {
  transcript: string;
  presetStatus: string | null;
  statedLocation: GroundedField | null;
  requestedAction: GroundedField | null;
  avoid: GroundedField | null;
  condition: GroundedField | null;
  contactPreference: GroundedField | null;
  /** How the card was produced, e.g. "qwen2.5:3b-instruct" or "rules". */
  extractor: string;
}

export interface Responder {
  memberId: string;
  at: Millis;
}

export interface Member {
  id: string;
  name: string;
  joinedAt: Millis;
  policy: CheckInPolicy;
  lastCheckInAt: Millis;
  nextDueAt: Millis;
  lastLocation: GeoFix | null;
  battery: { level: number; at: Millis } | null;
  stage: Stage;
  stageSince: Millis;
  sos: { at: Millis; status: string | null } | null;
  /** Latest voice note / status card, kept until the member is resolved. */
  card: AlertCard | null;
  responders: Responder[];
  lowBatteryAlerted: boolean;
  /** Set when external contacts were texted, so they also get the all-clear. */
  contactsAlertedAt: Millis | null;
  leftAt: Millis | null;
}

export type TimelineKind =
  | 'joined'
  | 'check-in'
  | 'snoozed'
  | 'prompt'
  | 'nudge'
  | 'overdue'
  | 'escalated'
  | 'sos'
  | 'card'
  | 'ack'
  | 'resolved'
  | 'battery-low'
  | 'left'
  | 'ended';

export interface TimelineEntry {
  at: Millis;
  kind: TimelineKind;
  memberId: string;
  /** Who did it, when different from the member it is about. */
  byId?: string;
  detail?: string;
}

export interface Session {
  id: string;
  name: string;
  /** IANA zone used to print clock times in texts, e.g. "America/New_York". */
  timeZone: string;
  createdAt: Millis;
  endsAt: Millis;
  endedAt: Millis | null;
  members: Member[];
  timeline: TimelineEntry[];
}

export type AlertReason = 'overdue' | 'sos' | 'sos-update' | 'battery-low' | 'manual';

/**
 * Side effects the engine asks the host to perform. The engine never sends
 * anything itself, which keeps it pure and testable.
 */
export type Effect =
  | { kind: 'prompt'; memberId: string; loud: boolean }
  | { kind: 'group-alert'; memberId: string; reason: AlertReason }
  | { kind: 'contacts-alert'; memberId: string; reason: AlertReason }
  | { kind: 'responder'; memberId: string; responderId: string }
  | { kind: 'card'; memberId: string }
  | { kind: 'all-clear'; memberId: string; byId: string; notifyContacts: boolean }
  | { kind: 'left'; memberId: string };

export interface Result {
  session: Session;
  effects: Effect[];
}
