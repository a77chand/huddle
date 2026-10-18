import { incident, incidentText, type Effect, type Millis, type Session } from '@huddle/core';

export interface PushMessage {
  channel: 'push';
  memberIds: string[];
  title: string;
  body: string;
  /** 'sos' and 'alert' map to high-priority notification channels on the phone. */
  urgency: 'sos' | 'alert' | 'checkin' | 'info';
  data: { sessionId: string; memberId: string; kind: Effect['kind'] };
}

export interface SmsMessage {
  channel: 'sms';
  to: string[];
  body: string;
}

export type Outbound = PushMessage | SmsMessage;

/** Turn engine effects into concrete notifications. Pure. */
export function render(session: Session, effects: Effect[], now: Millis): Outbound[] {
  const out: Outbound[] = [];
  const name = (id: string) => session.members.find((m) => m.id === id)?.name ?? 'Someone';
  const others = (...exclude: string[]) =>
    session.members.filter((m) => m.leftAt === null && !exclude.includes(m.id)).map((m) => m.id);
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: session.timeZone, hour: 'numeric', minute: '2-digit' });

  for (const e of effects) {
    const m = session.members.find((x) => x.id === e.memberId);
    if (!m) continue;
    const push = (memberIds: string[], title: string, body: string, urgency: PushMessage['urgency']) => {
      if (memberIds.length)
        out.push({ channel: 'push', memberIds, title, body, urgency, data: { sessionId: session.id, memberId: m.id, kind: e.kind } });
    };
    const where = m.lastLocation ? ` Last location ${clock.format(m.lastLocation.at)}.` : '';

    switch (e.kind) {
      case 'prompt':
        // The phone schedules "Still okay?" locally so it works offline; pushing too would double it.
        break;
      case 'group-alert':
        if (e.reason === 'overdue')
          push(others(m.id), `${m.name} missed a check-in`, `Last check-in ${clock.format(m.lastCheckInAt)}.${where} Unreachable — not confirmed in danger. Try calling.`, 'alert');
        else if (e.reason === 'battery-low')
          push(others(m.id), `${m.name}'s phone is almost dead`, `Battery ${Math.round((m.battery?.level ?? 0) * 100)}%.${where} They may go quiet soon.`, 'alert');
        else
          push(others(m.id), `${e.reason === 'sos' ? '🚨' : 'Update:'} ${m.name} asked for help`, `${m.sos?.status ? `"${m.sos.status}". ` : ''}${where.trim() || 'No location shared.'}`, 'sos');
        break;
      case 'contacts-alert': {
        const i = incident(session, m.id, now);
        const to = m.policy.contacts.map((c) => c.phone);
        if (i && to.length) out.push({ channel: 'sms', to, body: incidentText(i, session.name) });
        break;
      }
      case 'responder':
        push([m.id], `${name(e.responderId)} is on it`, `${name(e.responderId)} saw your alert and is responding.`, 'info');
        push(others(m.id, e.responderId), `${name(e.responderId)} is responding to ${m.name}`, 'Open Huddle to coordinate.', 'info');
        break;
      case 'card': {
        const c = m.card;
        if (!c) break;
        const bits = [c.requestedAction?.value, c.avoid && `don't ${c.avoid.value}`, c.statedLocation?.value, c.presetStatus]
          .filter(Boolean)
          .join(' · ');
        push(others(m.id), `${m.name} sent details`, bits || 'Voice note received — open Huddle.', m.sos ? 'sos' : 'alert');
        break;
      }
      case 'all-clear':
        push(
          others(m.id),
          `${m.name} is okay`,
          e.byId === m.id ? `${m.name} checked in.` : `${name(e.byId)} marked ${m.name} as safe.`,
          'info',
        );
        if (e.notifyContacts && m.policy.contacts.length)
          out.push({
            channel: 'sms',
            to: m.policy.contacts.map((c) => c.phone),
            body: `[Huddle · ${session.name}] All clear: ${e.byId === m.id ? `${m.name} checked in and is okay` : `${name(e.byId)} marked ${m.name} as safe`} (${clock.format(now)}). No action needed.`,
          });
        break;
      case 'left':
        push(others(m.id), `${m.name} left the session`, 'They are no longer sharing check-ins.', 'info');
        break;
    }
  }
  return out;
}

