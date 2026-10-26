import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  acknowledge,
  attachCard,
  board,
  checkIn,
  createSession,
  escalate,
  HuddleError,
  incident,
  incidentText,
  join,
  leave,
  nextWakeAt,
  reportBattery,
  removeMember,
  reportSightings,
  resolve,
  shareLocation,
  snooze,
  sos,
  tick,
  digestToUuid,
  expectedTokens,
  proximityWindow,
  tokenMessage,
  type CheckInPolicy,
  type Effect,
  type Session,
} from '../src/index.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 3, 0); // 11:00 PM in New York
const policy: CheckInPolicy = {
  intervalMin: 20,
  graceMin: 10,
  escalateAfterMin: 15,
  contacts: [{ name: 'Mom', phone: '+14155550123' }],
  sosNotifiesContacts: true,
};

/** Three friends at a concert. */
function concert(): Session {
  let s = createSession({
    id: 's1',
    name: 'Concert',
    now: T0,
    timeZone: 'America/New_York',
    proximityKey: '00112233445566778899aabbccddeeff',
    founder: { id: 'ana', name: 'Ana', policy },
  }).session;
  s = join(s, { id: 'bea', name: 'Bea', policy }, T0).session;
  s = join(s, { id: 'cy', name: 'Cy', policy }, T0).session;
  return s;
}

const kinds = (e: Effect[]) => e.map((x) => `${x.kind}:${x.memberId}`);

test('missed check-in climbs the ladder once per stage', () => {
  let s = concert();
  // Ana and Bea check in at 11:20; Cy goes quiet.
  s = checkIn(s, 'ana', T0 + 20 * MIN).session;
  s = checkIn(s, 'bea', T0 + 20 * MIN).session;

  let r = tick(s, T0 + 20 * MIN);
  assert.deepEqual(kinds(r.effects), ['prompt:cy']);
  r = tick(r.session, T0 + 21 * MIN);
  assert.deepEqual(r.effects, [], 'idempotent');

  r = tick(r.session, T0 + 25 * MIN);
  assert.deepEqual(r.effects, [{ kind: 'prompt', memberId: 'cy', loud: true }]);

  r = tick(r.session, T0 + 30 * MIN);
  assert.deepEqual(kinds(r.effects), ['group-alert:cy']);
  assert.equal(board(r.session, T0 + 30 * MIN).counts.needAttention, 1);

  // Ana and Bea come due again at 11:40, so look only at Cy from here.
  const cy = (e: Effect[]) => kinds(e).filter((k) => k.endsWith(':cy'));
  r = tick(r.session, T0 + 45 * MIN);
  assert.deepEqual(cy(r.effects), ['contacts-alert:cy']);
  r = tick(r.session, T0 + 60 * MIN);
  assert.deepEqual(cy(r.effects), []);
});

test('a host that slept through stages still alerts, without stale prompts', () => {
  const r = tick(concert(), T0 + 50 * MIN);
  // Every member jumped straight to escalated: group-alert then contacts-alert, no prompts.
  assert.deepEqual(
    r.effects.map((e) => e.kind),
    ['group-alert', 'contacts-alert', 'group-alert', 'contacts-alert', 'group-alert', 'contacts-alert'],
  );
});

test('checking in after the group was told sends an all-clear', () => {
  let s = tick(concert(), T0 + 31 * MIN).session;
  const r = checkIn(s, 'cy', T0 + 32 * MIN);
  assert.deepEqual(r.effects, [{ kind: 'all-clear', memberId: 'cy', byId: 'cy', notifyContacts: false }]);
  assert.equal(board(r.session, T0 + 32 * MIN).rows.find((x) => x.id === 'cy')!.status, 'ok');
});

test('a responder pauses automatic escalation; a person can still escalate', () => {
  let s = tick(concert(), T0 + 30 * MIN).session;
  const ack = acknowledge(s, 'ana', 'cy', T0 + 31 * MIN);
  assert.deepEqual(ack.effects, [{ kind: 'responder', memberId: 'cy', responderId: 'ana' }]);
  s = ack.session;
  const later = tick(s, T0 + 60 * MIN);
  assert.ok(!later.effects.some((e) => e.kind === 'contacts-alert' && e.memberId === 'cy'));
  const esc = escalate(later.session, 'ana', 'cy', T0 + 61 * MIN);
  assert.deepEqual(kinds(esc.effects), ['contacts-alert:cy']);
});

test('SOS alerts immediately, ignores the timer, and needs an explicit resolve', () => {
  let s = concert();
  const r = sos(s, 'bea', T0 + 5 * MIN, {
    location: { lat: 40.75051, lng: -73.99341, accuracyM: 12, at: T0 + 5 * MIN },
    status: 'Need help',
  });
  assert.deepEqual(kinds(r.effects), ['group-alert:bea', 'contacts-alert:bea']);
  s = r.session;
  assert.ok(!tick(s, T0 + 60 * MIN).effects.some((e) => e.memberId === 'bea'));
  s = checkIn(s, 'bea', T0 + 6 * MIN).session;
  assert.equal(board(s, T0 + 6 * MIN).rows.find((x) => x.id === 'bea')!.status, 'sos', 'a check-in does not cancel SOS');
  const done = resolve(s, 'ana', 'bea', T0 + 10 * MIN);
  assert.deepEqual(done.effects, [{ kind: 'all-clear', memberId: 'bea', byId: 'ana', notifyContacts: true }]);
  assert.equal(board(done.session, T0 + 10 * MIN).counts.needAttention, 0);
});

test('incident view separates known, unknown and next steps', () => {
  let s = checkIn(concert(), 'cy', T0 + 20 * MIN, {
    location: { lat: 40.75051, lng: -73.99341, at: T0 + 20 * MIN },
  }).session;
  s = tick(s, T0 + 70 * MIN).session;
  const i = incident(s, 'cy', T0 + 70 * MIN)!;
  assert.match(i.headline, /unreachable, not confirmed in danger/);
  assert.ok(i.known.some((k) => k.startsWith('Last check-in: 11:20 PM')));
  assert.ok(i.known.some((k) => k.includes('maps.google.com/?q=40.75051,-73.99341')));
  assert.ok(i.unknown.some((u) => u.includes('dead battery')));
  assert.ok(i.unknown.some((u) => u.includes('over 15 minutes old')));
  assert.equal(i.nextSteps[0], 'Call or text Cy directly.');
  assert.match(incidentText(i, 'Concert'), /^\[Huddle · Concert\]/);
  assert.equal(incident(s, 'ana', T0 + 70 * MIN)?.memberId, 'ana', 'Ana is overdue too');
  assert.equal(incident(checkIn(s, 'ana', T0 + 71 * MIN).session, 'ana', T0 + 71 * MIN), null);
});

test('the voice-note card drives the next steps', () => {
  let s = sos(concert(), 'bea', T0).session;
  s = attachCard(s, 'bea', {
    transcript: "I'm near the north entrance, please call me, don't come inside",
    presetStatus: null,
    statedLocation: { value: 'near the north entrance', quote: 'near the north entrance' },
    requestedAction: { value: 'call me', quote: 'please call me' },
    avoid: { value: 'come inside', quote: "don't come inside" },
    condition: null,
    contactPreference: { value: 'phone call', quote: 'please call me' },
    extractor: 'test',
  }, T0 + MIN).session;
  const i = incident(s, 'bea', T0 + 2 * MIN)!;
  assert.equal(i.nextSteps[0], 'Contact them the way they asked: phone call.');
  assert.ok(i.nextSteps.includes('Respect: do not come inside.'));
  assert.ok(!i.nextSteps.some((x) => x.includes('head to the last shared location')));
});

test('low battery alerts once until recharged', () => {
  let r = reportBattery(concert(), 'cy', 0.04, T0);
  assert.deepEqual(kinds(r.effects), ['group-alert:cy']);
  r = reportBattery(r.session, 'cy', 0.03, T0 + MIN);
  assert.deepEqual(r.effects, []);
  r = reportBattery(r.session, 'cy', 0.5, T0 + 2 * MIN);
  r = reportBattery(r.session, 'cy', 0.05, T0 + 3 * MIN);
  assert.deepEqual(kinds(r.effects), ['group-alert:cy']);
});

test('snooze moves the next check-in; nextWakeAt follows the earliest stage', () => {
  let s = snooze(concert(), 'ana', 120, T0).session;
  assert.equal(s.members[0]!.nextDueAt, T0 + 120 * MIN);
  assert.equal(nextWakeAt(s), T0 + 20 * MIN, 'Bea and Cy are still due at 11:20');
  s = checkIn(checkIn(s, 'bea', T0 + 100 * MIN).session, 'cy', T0 + 100 * MIN).session;
  assert.equal(nextWakeAt(s), T0 + 120 * MIN);
});

test('leaving stops tracking and forgets location; session expiry ends everything', () => {
  let s = checkIn(concert(), 'cy', T0, { location: { lat: 1, lng: 2, at: T0 } }).session;
  s = leave(s, 'cy', T0 + MIN).session;
  assert.equal(s.members[2]!.lastLocation, null);
  assert.ok(!tick(s, T0 + 60 * MIN).effects.some((e) => e.memberId === 'cy'));
  const ended = tick(s, T0 + 13 * 60 * MIN).session;
  assert.notEqual(ended.endedAt, null);
  assert.throws(() => checkIn(ended, 'ana', T0 + 13 * 60 * MIN), HuddleError);
});

test('bad input is rejected', () => {
  const s = concert();
  assert.throws(() => join(s, { id: 'd', name: 'D', policy: { ...policy, intervalMin: 1 } }, T0), /intervalMin/);
  assert.throws(() => join(s, { id: 'd', name: 'D', policy: { ...policy, contacts: [{ name: 'X', phone: '555' }] } }, T0), /E\.164/);
  assert.throws(() => join(s, { id: 'd', name: 'D', phone: '12345' }, T0), /E\.164/);
  assert.equal(join(s, { id: 'd', name: 'D', phone: '+447700900123' }, T0).session.members[3]!.phone, '+447700900123');
  assert.throws(() => acknowledge(s, 'ana', 'bea', T0), /not overdue/);
  assert.throws(() => acknowledge(tick(s, T0 + 31 * MIN).session, 'cy', 'cy', T0), /yourself/);
});

test('Bluetooth sightings: recorded both ways, never a check-in, shown to responders', () => {
  let s = checkIn(concert(), 'cy', T0 + 20 * MIN).session;
  s = reportSightings(s, 'ana', [
    { memberId: 'cy', at: T0 + 32 * MIN },
    { memberId: 'cy', at: T0 + 25 * MIN }, // older, ignored
    { memberId: 'ana', at: T0 + 32 * MIN }, // self, ignored
    { memberId: 'nobody', at: T0 + 32 * MIN }, // unknown, ignored
    { memberId: 'bea', at: T0 + 99 * MIN }, // future, ignored
  ], T0 + 33 * MIN).session;
  assert.deepEqual(s.members[2]!.seenNear, { ana: T0 + 32 * MIN });
  assert.deepEqual(s.members[0]!.seenNear, { cy: T0 + 32 * MIN });
  assert.equal(s.members[2]!.lastCheckInAt, T0 + 20 * MIN, 'being near a friend is not a check-in');

  s = tick(s, T0 + 55 * MIN).session;
  const b = board(s, T0 + 55 * MIN).rows.find((r) => r.id === 'cy')!;
  assert.deepEqual(b.lastNear, { memberId: 'ana', name: 'Ana', at: T0 + 32 * MIN });
  const i = incident(s, 'cy', T0 + 55 * MIN)!;
  assert.ok(i.known.includes("Last near Ana's phone at 11:32 PM (23 min ago, Bluetooth) — after their last check-in."));
  assert.ok(i.nextSteps.includes("Ask Ana — their phone was last near Cy's."));
});

test('rotating Bluetooth IDs: stable within a window, different across windows and members', async () => {
  const sha = async (x: string) => createHash('sha256').update(x).digest('hex');
  const key = '00112233445566778899aabbccddeeff';
  const t = T0 + 7 * MIN;
  const mine = digestToUuid(await sha(tokenMessage(key, 'cy', proximityWindow(t))));
  assert.match(mine, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  const table = await expectedTokens(key, ['ana', 'bea', 'cy'], t, sha);
  assert.equal(table.get(mine), 'cy');
  assert.equal(table.size, 9);
  const later = digestToUuid(await sha(tokenMessage(key, 'cy', proximityWindow(t) + 5)));
  assert.equal(table.get(later), undefined, 'old IDs stop matching');
  const other = await expectedTokens('ffeeddccbbaa99887766554433221100', ['cy'], t, sha);
  assert.ok(![...other.keys()].includes(mine), 'another session cannot recognise Cy');
});

test('live location: updates position without checking in; off clears the flag; leaving wipes it', () => {
  let s = shareLocation(concert(), 'cy', { live: true, location: { lat: 1, lng: 2, at: T0 + 5 * MIN } }, T0 + 5 * MIN).session;
  s = shareLocation(s, 'cy', { live: true, location: { lat: 9, lng: 9, at: T0 + 1 * MIN } }, T0 + 6 * MIN).session; // older fix ignored
  const row = () => board(s, T0 + 6 * MIN).rows.find((r) => r.id === 'cy')!;
  assert.equal(row().liveLocation, true);
  assert.deepEqual(row().lastLocation, { lat: 1, lng: 2, at: T0 + 5 * MIN });
  assert.equal(row().lastCheckInAt, T0, 'not a check-in');
  s = tick(s, T0 + 31 * MIN).session;
  assert.ok(incident(s, 'cy', T0 + 31 * MIN)!.known.some((k) => k.includes('live sharing on')));
  s = shareLocation(s, 'cy', { live: false }, T0 + 32 * MIN).session;
  assert.equal(board(s, T0 + 32 * MIN).rows.find((r) => r.id === 'cy')!.liveLocation, false);
  s = leave(shareLocation(s, 'cy', { live: true }, T0 + 33 * MIN).session, 'cy', T0 + 34 * MIN).session;
  assert.equal(s.members[2]!.liveLocationSince, null);
  assert.equal(s.members[2]!.lastLocation, null);
});

test('the host can remove someone; removal rotates the key; hosting passes on if the host leaves', () => {
  let s: Session = { ...concert(), e2e: true, keyEpoch: 1 };
  assert.equal(board(s, T0).hostId, 'ana');
  assert.throws(() => removeMember(s, 'bea', 'cy', T0), /only the host/);
  assert.throws(() => removeMember(s, 'ana', 'ana', T0), /use leave/);
  const r = removeMember(s, 'ana', 'cy', T0 + MIN);
  assert.deepEqual(r.effects, [{ kind: 'left', memberId: 'cy', removedBy: 'ana' }]);
  s = r.session;
  assert.equal(s.members[2]!.leftAt, T0 + MIN);
  assert.equal(s.keyEpoch, 2, 'removal rotates the group key');
  assert.equal(s.timeline.at(-1)!.kind, 'removed');
  s = leave(s, 'ana', T0 + 2 * MIN).session;
  assert.equal(board(s, T0 + 2 * MIN).hostId, 'bea', 'the longest-standing member becomes host');
});
