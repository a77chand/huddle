import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { decryptBoard, planKeySync, type AlertCard, type GeoFix } from '@huddle/core';
import { fromB64, generateKeyPair, proximityKeyFrom, seal, type KeyPair, type SealedField } from '@huddle/core/e2e';
import { ApiError, type Client, type View } from './api';

/**
 * End-to-end keys on this phone. The server stores only public keys and group
 * keys sealed to them; the secret key and the group keys live in the keychain.
 */
export const random = (n: number) => Crypto.getRandomBytes(n);

export interface SessionKeys {
  keyPair: KeyPair;
  /** epoch -> group key (base64url) */
  epochs: Record<string, string>;
}

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const slot = (sessionId: string) => `huddle.keys.${sessionId.replace(/[^A-Za-z0-9._-]/g, '')}`;

export async function loadKeys(sessionId: string): Promise<SessionKeys | null> {
  try {
    const raw = await SecureStore.getItemAsync(slot(sessionId), OPTS);
    return raw ? (JSON.parse(raw) as SessionKeys) : null;
  } catch {
    return null;
  }
}

export async function saveKeys(sessionId: string, k: SessionKeys) {
  await SecureStore.setItemAsync(slot(sessionId), JSON.stringify(k), OPTS);
}

export async function forgetKeys(sessionId: string) {
  await SecureStore.deleteItemAsync(slot(sessionId), OPTS).catch(() => {});
}

export const newKeyPair = () => generateKeyPair(random);

/** "<epoch>.<key>" — carried in invite links so link-joiners can read immediately. */
export function inviteKeyParam(k: SessionKeys, epoch: number): string | null {
  const key = k.epochs[String(epoch)];
  return key ? `${epoch}.${key}` : null;
}

export function parseInviteKey(param: string | undefined): { epoch: number; key: string } | null {
  const m = /^(\d+)\.([A-Za-z0-9_-]{43})$/.exec(param ?? '');
  if (!m) return null;
  try {
    if (fromB64(m[2]!).length !== 32) return null;
  } catch {
    return null;
  }
  return { epoch: Number(m[1]), key: m[2]! };
}

/**
 * Bring this phone's keys in line with the server's key state (see planKeySync):
 * open keys wrapped for us, share the current key with newcomers, claim a new
 * epoch if nobody has. Returns updated keys if anything changed.
 */
export async function syncKeys(view: View, keys: SessionKeys, api: Client): Promise<SessionKeys | null> {
  if (!view.keys) return null;
  const plan = planKeySync(view.keys, keys.epochs, view.me, keys.keyPair, random);
  if (plan.upload) {
    try {
      await api.keys(plan.upload.epoch, plan.upload.wraps);
    } catch (e) {
      // 409/403: another phone got there first — discard a key we generated and take theirs next view.
      if (!(e instanceof ApiError && (e.status === 409 || e.status === 403))) throw e;
      if (!keys.epochs[String(plan.upload.epoch)]) {
        const { [String(plan.upload.epoch)]: _lost, ...rest } = plan.epochs;
        return Object.keys(rest).length !== Object.keys(keys.epochs).length ? { keyPair: keys.keyPair, epochs: rest } : null;
      }
    }
  }
  return plan.changed ? { keyPair: keys.keyPair, epochs: plan.epochs } : null;
}

export interface Sealer {
  location(fix: GeoFix): { blob: string; at: number };
  status(text: string): string;
  card(card: AlertCard): string;
}

/**
 * Background (no view available): seal a location with the newest key this
 * phone holds. Returns the request payload, honouring the contacts-escrow setting.
 */
export async function backgroundLocationPayload(
  m: { sessionId: string; memberId: string; e2e?: boolean },
  fix: GeoFix,
  escrow: boolean,
): Promise<{ location?: GeoFix; sealedLocation?: { blob: string; at: number } }> {
  if (!m.e2e) return { location: fix };
  const k = await loadKeys(m.sessionId);
  const epochs = Object.keys(k?.epochs ?? {}).map(Number);
  const out: { location?: GeoFix; sealedLocation?: { blob: string; at: number } } = escrow ? { location: fix } : {};
  if (k && epochs.length) {
    const epoch = Math.max(...epochs);
    out.sealedLocation = {
      blob: seal(fix, { sessionId: m.sessionId, memberId: m.memberId, field: 'location', epoch, key: k.epochs[String(epoch)]! }, random),
      at: fix.at,
    };
  }
  return out;
}

/** Seal values for the group under the current epoch, or null if this phone doesn't have the key yet. */
export function sealer(view: View, keys: SessionKeys | null): Sealer | null {
  const epoch = view.keys?.epoch;
  const key = epoch !== undefined ? keys?.epochs[String(epoch)] : undefined;
  if (!view.board.e2e || epoch === undefined || !key) return null;
  const ctx = (field: SealedField) => ({ sessionId: view.board.sessionId, memberId: view.me, field, epoch, key });
  return {
    location: (fix) => ({ blob: seal(fix, ctx('location'), random), at: fix.at }),
    status: (text) => seal(text, ctx('status'), random),
    card: (card) => seal(card, ctx('card'), random),
  };
}

/** Decrypt every sealed field this phone can open and rebuild incidents locally. */
export function decryptView(view: View, keys: SessionKeys | null, now = Date.now()): View {
  if (!view.board.e2e || !keys) return view;
  const { board, incidents } = decryptBoard(view.board, keys.epochs, now);
  return { ...view, board, incidents };
}

/** In encrypted huddles the Bluetooth key comes from the group key, which the server never sees. */
export function proximityKeyFor(view: View, keys: SessionKeys | null): string | null {
  if (!view.board.e2e) return view.proximityKey;
  const key = view.keys ? keys?.epochs[String(view.keys.epoch)] : undefined;
  return key ? proximityKeyFrom(key) : null;
}
