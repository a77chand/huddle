/**
 * Rotating Bluetooth IDs. Each phone broadcasts an ID derived from the session's
 * secret, its member id and the current 15-minute window. Members can compute
 * everyone's IDs and recognise friends; anyone else sees random-looking UUIDs
 * that change every 15 minutes. The server only ever learns "A was near B".
 */

export const PROXIMITY_WINDOW_MS = 15 * 60_000;

/** Fixed service UUID every Huddle phone advertises, so scanners can filter. */
export const HUDDLE_BLE_SERVICE = '7A6E0001-4875-6464-6C65-50524F580001';

export function proximityWindow(t: number): number {
  return Math.floor(t / PROXIMITY_WINDOW_MS);
}

/** Input to SHA-256; the first 16 bytes of the digest become the ID. */
export function tokenMessage(key: string, memberId: string, window: number): string {
  return `huddle-prox:v1:${key}:${memberId}:${window}`;
}

/** First 32 hex chars of a digest, formatted as a UUID so it fits in a BLE advertisement. */
export function digestToUuid(hex: string): string {
  const h = hex.slice(0, 32).toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(h)) throw new Error('need at least 32 hex chars');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Every ID a member could currently be broadcasting (previous, current and next
 * window, to tolerate clock skew), mapped back to the member.
 */
export async function expectedTokens(
  key: string,
  memberIds: string[],
  now: number,
  sha256Hex: (s: string) => Promise<string>,
): Promise<Map<string, string>> {
  const w = proximityWindow(now);
  const out = new Map<string, string>();
  for (const id of memberIds)
    for (const win of [w - 1, w, w + 1]) out.set(digestToUuid(await sha256Hex(tokenMessage(key, id, win))), id);
  return out;
}
