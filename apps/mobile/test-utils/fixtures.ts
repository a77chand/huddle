import { board, checkIn, createSession, incident, join, tick } from '@huddle/core';
import type { View } from '../src/lib/api';

export const T0 = Date.UTC(2026, 9, 17, 3, 0);
const MIN = 60_000;
const policy = { intervalMin: 20, graceMin: 10, escalateAfterMin: null, contacts: [], sosNotifiesContacts: true };

/** Ana (host), Bea, and Cy who went quiet 15 minutes past their check-in. */
export function concertView(me: 'ana' | 'bea', e2e = true): { view: View; now: number } {
  let s = createSession({ id: 's1', name: 'Concert', now: T0, timeZone: 'UTC', proximityKey: '0'.repeat(32), founder: { id: 'ana', name: 'Ana', policy } }).session;
  s = join(s, { id: 'bea', name: 'Bea', policy }, T0).session;
  s = join(s, { id: 'cy', name: 'Cy', policy }, T0).session;
  s = checkIn(s, 'ana', T0 + 30 * MIN).session;
  s = checkIn(s, 'bea', T0 + 30 * MIN).session;
  const now = T0 + 45 * MIN;
  s = tick(s, now).session;
  const b = { ...board(s, now), e2e };
  return {
    now,
    view: {
      me,
      joinCode: 'ABC123',
      proximityKey: null,
      keys: e2e ? { epoch: 1, claimed: true, mine: [], needWrap: [] } : null,
      board: b,
      incidents: b.rows.filter((r) => r.needsAttention).map((r) => incident(s, r.id, now)!),
      timeline: [],
    },
  };
}

/** The shape screens read from useHuddle(), with no-op actions. */
export function huddleMock(view: View, extra: Record<string, unknown> = {}) {
  const me = view.board.rows.find((r) => r.id === view.me)!;
  const fn = () => jest.fn(async () => {});
  return {
    ready: true, profile: { name: 'Ana', phone: '', serverUrl: 'http://x', policy: {} }, membership: { token: 't', sessionId: 's1', memberId: view.me },
    view, me, connection: 'live', pendingCheckIn: false, proximity: 'poweredOn', liveLocation: 'off', batterySaver: false,
    onDeviceReady: false, onDeviceTimings: [], lastSosLocated: false, encryptionReady: true, inviteLink: 'huddle://start?code=ABC123', myPublicKey: null,
    refreshOnDevice: jest.fn(), saveProfile: fn(), start: fn(), join: fn(), checkIn: fn(), sos: fn(), sendStatus: fn(), sendVoice: fn(),
    snooze: fn(), ack: fn(), escalate: fn(), resolve: fn(), remove: fn(), updatePolicy: fn(), leave: fn(), refresh: fn(),
    ...extra,
  };
}
