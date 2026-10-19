import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import type { CheckInPolicy } from '@huddle/core';

export interface Profile {
  name: string;
  phone: string;
  serverUrl: string;
  /** Kept on the phone too, so an offline SOS can still text them. */
  policy: CheckInPolicy;
  /** Broadcast a rotating Bluetooth ID so friends' phones can note when we were near. */
  shareProximity?: boolean;
  /** Continuous low-power location sharing during a huddle. Off unless turned on. */
  shareLiveLocation?: boolean;
}

export interface Membership {
  token: string;
  sessionId: string;
  memberId: string;
}

export const DEFAULT_SERVER: string =
  process.env.EXPO_PUBLIC_SERVER_URL ?? (Constants.expoConfig?.extra?.serverUrl as string | undefined) ?? 'http://localhost:8787';

export const DEFAULT_POLICY: CheckInPolicy = {
  intervalMin: 30,
  graceMin: 10,
  escalateAfterMin: 20,
  contacts: [],
  sosNotifiesContacts: true,
};

/** Readable after the first unlock, so the background location task works while the phone is locked. */
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

async function read<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key, OPTS);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const storage = {
  profile: () => read<Profile>('huddle.profile'),
  saveProfile: (p: Profile) => SecureStore.setItemAsync('huddle.profile', JSON.stringify(p), OPTS),
  membership: () => read<Membership>('huddle.membership'),
  saveMembership: (m: Membership) => SecureStore.setItemAsync('huddle.membership', JSON.stringify(m), OPTS),
  clearMembership: () => SecureStore.deleteItemAsync('huddle.membership', OPTS),
};
