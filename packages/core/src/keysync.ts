/**
 * The phone side of E2E, as pure functions: deciding what to do with the
 * server's key state, and decrypting a board. The app calls these; the tests
 * run several simulated phones through them against the real server.
 */
import { incidentFromRow, isStale, type Board, type BoardRow, type Incident } from './board.ts';
import { generateGroupKey, open, unwrapKey, wrapKey, type KeyPair, type Random } from './e2e.ts';
import type { AlertCard, GeoFix } from './types.ts';

export interface KeyState {
  epoch: number;
  claimed: boolean;
  mine: { epoch: number; blob: string }[];
  needWrap: { memberId: string; publicKey: string }[];
}

export interface KeySyncPlan {
  /** epoch -> group key, including anything newly unwrapped or generated. */
  epochs: Record<string, string>;
  changed: boolean;
  /** Wraps to upload to POST /v1/keys, if any. */
  upload: { epoch: number; wraps: { memberId: string; blob: string }[] } | null;
}

export function planKeySync(state: KeyState, held: Record<string, string>, me: string, keyPair: KeyPair, random: Random): KeySyncPlan {
  const epochs = { ...held };
  let changed = false;
  for (const w of state.mine) {
    if (epochs[String(w.epoch)]) continue; // an invite-link key is trusted over a server-relayed one
    try {
      epochs[String(w.epoch)] = unwrapKey(w.blob, keyPair, w.epoch);
      changed = true;
    } catch {
      /* not for us, or corrupted */
    }
  }
  const current = epochs[String(state.epoch)];
  if (current && state.needWrap.length) {
    return { epochs, changed, upload: { epoch: state.epoch, wraps: wrapAll(current, state, random) } };
  }
  if (!current && !state.claimed && state.needWrap.some((m) => m.memberId === me)) {
    const fresh = generateGroupKey(random);
    epochs[String(state.epoch)] = fresh;
    return { epochs, changed: true, upload: { epoch: state.epoch, wraps: wrapAll(fresh, state, random) } };
  }
  return { epochs, changed, upload: null };
}

function wrapAll(key: string, state: KeyState, random: Random) {
  return state.needWrap.map((m) => ({ memberId: m.memberId, blob: wrapKey(key, m.publicKey, state.epoch, random) }));
}

/** Decrypt every sealed field these keys can open, and rebuild incidents locally. */
export function decryptBoard(board: Board, epochs: Record<string, string>, now: number): { board: Board; incidents: Incident[] } {
  const keys = new Map(Object.entries(epochs).map(([e, k]) => [Number(e), k]));
  const tryOpen = <T>(blob: string | null | undefined, memberId: string, field: 'location' | 'card' | 'status'): T | null => {
    if (!blob) return null;
    try {
      return open<T>(blob, { sessionId: board.sessionId, memberId, field, keys });
    } catch {
      return null;
    }
  };
  const rows: BoardRow[] = board.rows.map((r) => {
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
  const incidents = rows.filter((r) => r.needsAttention).map((r) => incidentFromRow(r, rows, board.timeZone, now)!);
  return { board: { ...board, rows }, incidents };
}
