import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  bytesToUtf8,
  envelopeEpoch,
  fingerprint,
  fromB64,
  generateGroupKey,
  generateKeyPair,
  open,
  proximityKeyFrom,
  seal,
  toB64,
  unwrapKey,
  utf8ToBytes,
  wrapKey,
} from '../src/e2e.ts';
import { attachSealedCard, board, checkIn, createSession, incident, incidentFromRow, join, leave, sos, tick } from '../src/index.ts';

const rand = (n: number) => new Uint8Array(randomBytes(n));

test('built-in UTF-8 matches the platform encoder', () => {
  for (const s of ['', 'abc', 'Estoy en la entrada sur — ñ', 'मुझे चक्कर', '😀 emoji', 'Je suis devant la scène']) {
    assert.deepEqual(utf8ToBytes(s), new TextEncoder().encode(s));
    assert.equal(bytesToUtf8(utf8ToBytes(s)), s);
  }
});

test('base64url round-trips every length', () => {
  for (let n = 0; n < 70; n++) {
    const b = rand(n);
    assert.deepEqual(fromB64(toB64(b)), b);
    assert.equal(toB64(b), Buffer.from(b).toString('base64url'));
  }
});

test('group key wrapped for a member only opens with their secret key', () => {
  const ana = generateKeyPair(rand);
  const cy = generateKeyPair(rand);
  const key = generateGroupKey(rand);
  const wrapped = wrapKey(key, cy.publicKey, 1, rand);
  assert.equal(unwrapKey(wrapped, cy, 1), key);
  assert.throws(() => unwrapKey(wrapped, ana, 1), 'someone else cannot unwrap');
  assert.throws(() => unwrapKey(wrapped, cy, 2), 'bound to its epoch');
});

test('sealed fields decrypt for the group and resist tampering and swapping', () => {
  const key = generateGroupKey(rand);
  const keys = new Map([[3, key]]);
  const loc = { lat: 40.75051, lng: -73.99341, at: 1 };
  const env = seal(loc, { sessionId: 's1', memberId: 'cy', field: 'location', epoch: 3, key }, rand);
  assert.equal(envelopeEpoch(env), 3);
  assert.ok(!env.includes('40.75'), 'no plaintext in the envelope');
  assert.deepEqual(open(env, { sessionId: 's1', memberId: 'cy', field: 'location', keys }), loc);

  // Moved to another member, field or session: rejected.
  assert.throws(() => open(env, { sessionId: 's1', memberId: 'ana', field: 'location', keys }));
  assert.throws(() => open(env, { sessionId: 's1', memberId: 'cy', field: 'card', keys }));
  assert.throws(() => open(env, { sessionId: 's2', memberId: 'cy', field: 'location', keys }));
  // A flipped bit: rejected.
  const raw = fromB64(env.split('.')[2]!);
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => open(`e1.3.${toB64(raw)}`, { sessionId: 's1', memberId: 'cy', field: 'location', keys }));
  // Wrong epoch key: rejected.
  assert.throws(() => open(env, { sessionId: 's1', memberId: 'cy', field: 'location', keys: new Map([[3, generateGroupKey(rand)]]) }));
  assert.throws(() => open(env, { sessionId: 's1', memberId: 'cy', field: 'location', keys: new Map() }), /missing key/);
});

test('proximity key and fingerprints are deterministic', () => {
  const key = generateGroupKey(rand);
  assert.match(proximityKeyFrom(key), /^[0-9a-f]{32}$/);
  assert.equal(proximityKeyFrom(key), proximityKeyFrom(key));
  assert.notEqual(proximityKeyFrom(key), proximityKeyFrom(generateGroupKey(rand)));
  const kp = generateKeyPair(rand);
  assert.match(fingerprint(kp.publicKey), /^([0-9a-f]{4} ){4}[0-9a-f]{4}$/);
});

// ---- engine rules for encrypted huddles

test('encrypted huddle: server keeps ciphertext; plaintext only as the contact-text copy; epochs rotate on leave', () => {
  const T0 = Date.UTC(2026, 9, 17, 3, 0);
  const MIN = 60_000;
  const ana = generateKeyPair(rand);
  const cy = generateKeyPair(rand);
  const key = generateGroupKey(rand);
  const policy = { intervalMin: 20, graceMin: 10, escalateAfterMin: 15, contacts: [{ name: 'Mom', phone: '+14155550123' }], sosNotifiesContacts: true };
  let s = createSession({ id: 's1', name: 'Concert', now: T0, timeZone: 'America/New_York', proximityKey: '0'.repeat(32), e2e: true, founder: { id: 'ana', name: 'Ana', publicKey: ana.publicKey, policy } }).session;
  assert.throws(() => join(s, { id: 'x', name: 'Old app' }, T0), /encrypted/);
  s = join(s, { id: 'cy', name: 'Cy', publicKey: cy.publicKey, policy }, T0).session;

  const fix = { lat: 40.75051, lng: -73.99341, at: T0 + MIN };
  const sealedLocation = { blob: seal(fix, { sessionId: 's1', memberId: 'cy', field: 'location', epoch: 1, key }, rand), at: fix.at };
  s = checkIn(s, 'cy', T0 + MIN, { sealedLocation, location: fix }).session;
  const cyM = s.members[1]!;
  assert.equal(cyM.lastLocation, null, 'no plaintext location for the group');
  assert.deepEqual(cyM.contactLocation, fix, 'plaintext kept only for emergency texts');
  assert.ok(!JSON.stringify(board(s, T0 + MIN)).includes('40.75'), 'the board never carries the plaintext location');

  s = sos(s, 'cy', T0 + 2 * MIN, { status: 'plaintext leak?', sealedStatus: seal('Need help', { sessionId: 's1', memberId: 'cy', field: 'status', epoch: 1, key }, rand) }).session;
  assert.equal(s.members[1]!.sos!.status, null, 'plaintext status discarded');
  s = attachSealedCard(s, 'cy', seal({ transcript: 'x' }, { sessionId: 's1', memberId: 'cy', field: 'card', epoch: 1, key }, rand), T0 + 3 * MIN).session;
  assert.throws(() => attachSealedCard(s, 'cy', 'not-encrypted', T0), /encrypted value/);

  // Server-side incident for contacts uses the contact copy; for the group it points to the app.
  const forContacts = incident(s, 'cy', T0 + 4 * MIN, { forContacts: true })!;
  assert.ok(forContacts.known.some((k) => k.includes('maps.google.com/?q=40.75051')));
  const forGroup = incident(s, 'cy', T0 + 4 * MIN)!;
  assert.ok(forGroup.known.some((k) => k.includes('end-to-end encrypted, visible in the Huddle app')));
  assert.ok(!forGroup.known.some((k) => k.includes('40.75')));

  // A phone that decrypted the row gets the full incident locally.
  const rows = board(s, T0 + 4 * MIN).rows;
  const r = { ...rows[1]!, lastLocation: open<typeof fix>(rows[1]!.sealedLocation!.blob, { sessionId: 's1', memberId: 'cy', field: 'location', keys: new Map([[1, key]]) }) };
  assert.ok(incidentFromRow(r, rows, 'America/New_York', T0 + 4 * MIN)!.known.some((k) => k.includes('maps.google.com/?q=40.75051')));

  s = leave(s, 'cy', T0 + 5 * MIN).session;
  assert.equal(s.keyEpoch, 2);
  assert.equal(s.members[1]!.sealedLocation, null);
  assert.equal(s.members[1]!.contactLocation, null);
  s = tick(s, T0 + 13 * 60 * MIN).session;
  assert.equal(s.members[0]!.sealedLocation, null, 'session end wipes everything');
});
