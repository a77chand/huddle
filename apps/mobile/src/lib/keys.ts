import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { incidentFromRow, isStale, type AlertCard, type GeoFix } from '@huddle/core';
import {
  fromB64,
  generateGroupKey,
  generateKeyPair,
  open,
  proximityKeyFrom,
  seal,
  unwrapKey,
  wrapKey,
  type KeyPair,
  type SealedField,
} from '@huddle/core/e2e';
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
 * Bring this phone's keys in line with the server's key state: open keys
 * wrapped for us, share the current key with members who don't have it yet,
 * and claim a new epoch if nobody has (e.g. after someone left).
 * Returns updated keys if anything changed.
 */
export async function syncKeys(view: View, keys: SessionKeys, api: Client): Promise<SessionKeys | null> {
  const ks = view.keys;
  if (!ks) return null;
  let changed = false;
  const next: SessionKeys = { keyPair: keys.keyPair, epochs: { ...keys.epochs } };
  for (const w of ks.mine) {
    if (next.epochs[String(w.epoch)]) continue;
    try {
      next.epochs[String(w.epoch)] = unwrapKey(w.blob, keys.keyPair, w.epoch);
      changed = true;
    } catch {
      /* not for us or corrupted — ignore */
    }
  }
  const current = next.epochs[String(ks.epoch)];
  try {
    if (current && ks.needWrap.length) {
      await api.keys(ks.epoch, ks.needWrap.map((m) => ({ memberId: m.memberId, blob: wrapKey(current, m.publicKey, ks.epoch, random) })));
    } else if (!current && !ks.claimed && ks.needWrap.some((m) => m.memberId === view.me)) {
      const fresh = generateGroupKey(random);
      await api.keys(ks.epoch, ks.needWrap.map((m) => ({ memberId: m.memberId, blob: wrapKey(fresh, m.publicKey, ks.epoch, random) })));
      next.epochs[String(ks.epoch)] = fresh;
      changed = true;
    }
  } catch (e) {
    // 409/403: another phone got there first — we'll receive its key on the next view.
    if (!(e instanceof ApiError && (e.status === 409 || e.status === 403))) throw e;
  }
  return changed ? next : null;
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
  const map = new Map(Object.entries(keys.epochs).map(([e, k]) => [Number(e), k]));
  const sid = view.board.sessionId;
  const tryOpen = <T>(blob: string | undefined | null, memberId: string, field: SealedField): T | null => {
    if (!blob) return null;
    try {
      return open<T>(blob, { sessionId: sid, memberId, field, keys: map });
    } catch {
      return null;
    }
  };
  const rows = view.board.rows.map((r) => {
    const loc = tryOpen<GeoFix>(r.sealedLocation?.blob, r.id, 'location');
    const card = tryOpen<AlertCard>(r.sealedCard?.blob, r.id, 'card');
    const status = tryOpen<string>(r.sealedStatus, r.id, 'status');
    return {
      ...r,
      lastLocation: loc ?? r.lastLocation,
      locationStale: loc ? isStale(loc.at, now) : r.locationStale,
      card: card ?? r.card,
      sos: r.sos && { ...r.sos, status: status ?? r.sos.status },
    };
  });
  const incidents = rows.filter((r) => r.needsAttention).map((r) => incidentFromRow(r, rows, view.board.timeZone, now)!);
  return { ...view, board: { ...view.board, rows }, incidents };
}

/** In encrypted huddles the Bluetooth key comes from the group key, which the server never sees. */
export function proximityKeyFor(view: View, keys: SessionKeys | null): string | null {
  if (!view.board.e2e) return view.proximityKey;
  const key = view.keys ? keys?.epochs[String(view.keys.epoch)] : undefined;
  return key ? proximityKeyFrom(key) : null;
}
