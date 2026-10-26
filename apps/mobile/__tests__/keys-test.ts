import { randomBytes } from 'crypto';
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(require('crypto').randomBytes(n)) }));
jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK: 1,
    getItemAsync: async (k: string) => m.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void m.set(k, v),
    deleteItemAsync: async (k: string) => void m.delete(k),
  };
});
import { board, createSession, checkIn } from '@huddle/core';
import { generateGroupKey } from '@huddle/core/e2e';
import type { View } from '../src/lib/api';
import { decryptView, inviteKeyParam, loadKeys, newKeyPair, parseInviteKey, saveKeys, sealer } from '../src/lib/keys';

const rand = (n: number) => new Uint8Array(randomBytes(n));

test('invite links carry the key only in a well-formed way', () => {
  const key = generateGroupKey(rand);
  const kp = newKeyPair();
  const param = inviteKeyParam({ keyPair: kp, epochs: { '3': key } }, 3)!;
  expect(parseInviteKey(param)).toEqual({ epoch: 3, key });
  for (const bad of [undefined, '', '3', 'x.abc', `3.${key}x`, `3.${key.slice(0, -1)}`]) expect(parseInviteKey(bad)).toBeNull();
});

test('keys survive an app restart (keychain round trip)', async () => {
  const k = { keyPair: newKeyPair(), epochs: { '1': generateGroupKey(rand) } };
  await saveKeys('session-1', k);
  expect(await loadKeys('session-1')).toEqual(k);
  expect(await loadKeys('other')).toBeNull();
});

test('what one phone seals, another phone in the group decrypts into a full incident', () => {
  const T0 = Date.now();
  const key = generateGroupKey(rand);
  const ana = newKeyPair();
  const cy = newKeyPair();
  const policy = { intervalMin: 20, graceMin: 10, escalateAfterMin: null, contacts: [], sosNotifiesContacts: true };
  let s = createSession({ id: 's1', name: 'Gig', now: T0, proximityKey: '0'.repeat(32), e2e: true, founder: { id: 'cy', name: 'Cy', publicKey: cy.publicKey, policy } }).session;
  const view = (me: string): View => ({ me, joinCode: 'ABC123', proximityKey: null, keys: { epoch: 1, claimed: true, mine: [], needWrap: [] }, board: board(s, T0), incidents: [], timeline: [] });
  const sealCy = sealer(view('cy'), { keyPair: cy, epochs: { '1': key } })!;
  const fix = { lat: 51.5, lng: -0.12, at: T0 };
  s = checkIn(s, 'cy', T0, { sealedLocation: sealCy.location(fix) }).session;
  s.members[0]!.stage = 'overdue'; // pretend Cy went quiet
  const raw = view('ana');
  expect(JSON.stringify(raw)).not.toContain('51.5');
  const seen = decryptView({ ...raw, board: board(s, T0) }, { keyPair: ana, epochs: { '1': key } }, T0);
  expect(seen.board.rows[0]!.lastLocation).toEqual(fix);
  expect(seen.incidents[0]!.known.join(' ')).toContain('maps.google.com/?q=51.50000,-0.12000');
  // Without the key the phone shows the encrypted placeholder, never garbage.
  const blind = decryptView({ ...raw, board: board(s, T0) }, { keyPair: ana, epochs: {} }, T0);
  expect(blind.incidents[0]!.known.join(' ')).toContain('end-to-end encrypted');
});
