/**
 * End-to-end encryption for a huddle.
 *
 * - Every phone has an X25519 key pair; the public half is stored on the server.
 * - The group shares a random 32-byte key per *epoch*. The server never sees it:
 *   members hand it to each other wrapped (sealed) to each recipient's public key.
 * - Sensitive fields (locations, voice cards, statuses) are sealed with
 *   XChaCha20-Poly1305 under the current epoch key. The associated data binds
 *   each ciphertext to its session, member and field, so the server can't swap
 *   one person's location for another's.
 * - When someone leaves, the epoch advances and a fresh key is shared with the
 *   remaining members only.
 *
 * Randomness is passed in (expo-crypto on phones, node:crypto in tests).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export type Random = (n: number) => Uint8Array;

export interface KeyPair {
  publicKey: string; // base64url
  secretKey: string; // base64url — never leaves the phone
}

export type SealedField = 'location' | 'card' | 'status';

const WRAP_INFO = utf8ToBytes('huddle-wrap-v1');

// --------------------------------------------------------------- encoding

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new Error('bad base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | (i + k < clean.length ? B64.indexOf(clean[i + k]!) : 0), 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

const decoder = new TextDecoder();

// --------------------------------------------------------------- keys

export function generateKeyPair(random: Random): KeyPair {
  const secret = random(32);
  return { secretKey: toB64(secret), publicKey: toB64(x25519.getPublicKey(secret)) };
}

export function generateGroupKey(random: Random): string {
  return toB64(random(32));
}

/**
 * Seal a group key to one member's public key (an anonymous "sealed box"):
 * ephemeral X25519 → HKDF-SHA256 → XChaCha20-Poly1305. Output: "w1.<b64(ephPub|nonce|ct)>".
 */
export function wrapKey(groupKey: string, recipientPublicKey: string, epoch: number, random: Random): string {
  const recipient = fromB64(recipientPublicKey);
  const eph = random(32);
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, recipient);
  const k = hkdf(sha256, shared, concatBytes(ephPub, recipient), WRAP_INFO, 32);
  const nonce = random(24);
  const ct = xchacha20poly1305(k, nonce, utf8ToBytes(`epoch:${epoch}`)).encrypt(fromB64(groupKey));
  return `w1.${toB64(concatBytes(ephPub, nonce, ct))}`;
}

export function unwrapKey(wrapped: string, mine: KeyPair, epoch: number): string {
  if (!wrapped.startsWith('w1.')) throw new Error('unknown wrap format');
  const raw = fromB64(wrapped.slice(3));
  const ephPub = raw.subarray(0, 32);
  const nonce = raw.subarray(32, 56);
  const ct = raw.subarray(56);
  const myPub = fromB64(mine.publicKey);
  const shared = x25519.getSharedSecret(fromB64(mine.secretKey), ephPub);
  const k = hkdf(sha256, shared, concatBytes(ephPub, myPub), WRAP_INFO, 32);
  return toB64(xchacha20poly1305(k, nonce, utf8ToBytes(`epoch:${epoch}`)).decrypt(ct));
}

// --------------------------------------------------------------- fields

function aad(sessionId: string, memberId: string, field: SealedField): Uint8Array {
  return utf8ToBytes(`huddle:v1:${sessionId}:${memberId}:${field}`);
}

/** Encrypt a JSON value for the group. Output: "e1.<epoch>.<b64(nonce|ct)>". */
export function seal(
  value: unknown,
  ctx: { sessionId: string; memberId: string; field: SealedField; epoch: number; key: string },
  random: Random,
): string {
  const nonce = random(24);
  const ct = xchacha20poly1305(fromB64(ctx.key), nonce, aad(ctx.sessionId, ctx.memberId, ctx.field)).encrypt(
    utf8ToBytes(JSON.stringify(value)),
  );
  return `e1.${ctx.epoch}.${toB64(concatBytes(nonce, ct))}`;
}

export function envelopeEpoch(envelope: string): number | null {
  const m = /^e1\.(\d+)\./.exec(envelope);
  return m ? Number(m[1]) : null;
}

/** Decrypt a sealed field; throws if the key is missing or the data was tampered with or moved. */
export function open<T>(
  envelope: string,
  ctx: { sessionId: string; memberId: string; field: SealedField; keys: ReadonlyMap<number, string> },
): T {
  const epoch = envelopeEpoch(envelope);
  if (epoch === null) throw new Error('not a sealed value');
  const key = ctx.keys.get(epoch);
  if (!key) throw new Error(`missing key for epoch ${epoch}`);
  const raw = fromB64(envelope.slice(envelope.indexOf('.', 3) + 1));
  const pt = xchacha20poly1305(fromB64(key), raw.subarray(0, 24), aad(ctx.sessionId, ctx.memberId, ctx.field)).decrypt(raw.subarray(24));
  return JSON.parse(decoder.decode(pt)) as T;
}

/**
 * Bluetooth IDs are derived from the group key in encrypted huddles, so the
 * server can't compute anyone's rotating IDs.
 */
export function proximityKeyFrom(groupKey: string): string {
  return bytesToHex(hkdf(sha256, fromB64(groupKey), undefined, utf8ToBytes('huddle-proximity-v1'), 16));
}

/** Short fingerprint of a public key, for comparing in person ("safety number"). */
export function fingerprint(publicKey: string): string {
  const h = bytesToHex(sha256(fromB64(publicKey))).slice(0, 20);
  return h.match(/.{4}/g)!.join(' ');
}
