import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useEffect, useRef, useState } from 'react';
import type { GeoFix } from '@huddle/core';
import { ApiError, client } from './api';
import { backgroundLocationPayload } from './keys';
import { storage } from './storage';

/**
 * Opt-in live location, off by default. Uses the OS's low-power location
 * (Wi-Fi/cell, ~100 m) and only reports after real movement, so it costs far
 * less than navigation-style GPS. Pauses itself in Low Power Mode or under 20%.
 */
export const LIVE_LOCATION_TASK = 'huddle-live-location';

/** Upload at most this often unless the person has moved a lot. */
const MIN_UPLOAD_MS = 5 * 60_000;
const MIN_MOVE_M = 150;

const TASK_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Balanced,
  distanceInterval: MIN_MOVE_M,
  timeInterval: 2 * 60_000,
  deferredUpdatesDistance: MIN_MOVE_M,
  deferredUpdatesInterval: 3 * 60_000,
  pausesUpdatesAutomatically: true,
  activityType: Location.ActivityType.Other,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'Sharing your location with your huddle',
    notificationBody: 'Until the huddle ends. Turn it off in Huddle → Your details.',
    notificationColor: '#7C5CFF',
    killServiceOnDestroy: false,
  },
};

export type LiveLocationStatus = 'off' | 'on' | 'foreground-only' | 'paused-battery' | 'denied';

let lastSent: GeoFix | null = null;

function metersBetween(a: GeoFix, b: GeoFix): number {
  const R = 6371e3;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function batterySaverOn(): Promise<boolean> {
  try {
    const [level, low] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.isLowPowerModeEnabledAsync()]);
    return low || (level >= 0 && level < 0.2);
  } catch {
    return false;
  }
}

/** Send a fix if it's worth it; returns false when sharing should stop (session gone). */
async function upload(fix: GeoFix): Promise<boolean> {
  if (lastSent && fix.at - lastSent.at < MIN_UPLOAD_MS && metersBetween(lastSent, fix) < MIN_MOVE_M) return true;
  const [profile, membership] = await Promise.all([storage.profile(), storage.membership()]);
  if (!profile || !membership || !profile.shareLiveLocation) return false;
  try {
    const escrow = profile.contactLocation !== false && profile.policy.contacts.length > 0;
    const api = client(profile.serverUrl, membership.token);
    const payload = await backgroundLocationPayload(membership, fix, escrow);
    try {
      await api.location(true, payload);
    } catch (e) {
      // The group key rotated (someone left) and this phone hasn't been sent the new one yet:
      // never fall back to the old key; send only the contacts copy, if allowed.
      if (!(e instanceof ApiError && e.code === 'stale-epoch')) throw e;
      await api.location(true, payload.location ? { location: payload.location } : {});
    }
    lastSent = fix;
    return true;
  } catch (e) {
    return !(e instanceof ApiError && (e.status === 401 || e.status === 404 || e.code === 'ended' || e.code === 'left'));
  }
}

// Must be defined at module scope, before the app renders (imported from index.ts).
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LIVE_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  if (await batterySaverOn()) {
    await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK).catch(() => {});
    return;
  }
  const l = data.locations[data.locations.length - 1]!;
  const keep = await upload({ lat: l.coords.latitude, lng: l.coords.longitude, accuracyM: l.coords.accuracy ?? undefined, at: l.timestamp });
  if (!keep) await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK).catch(() => {});
});

async function stopAll(api: ReturnType<typeof client> | null, tellServer: boolean) {
  if (await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK).catch(() => false))
    await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK).catch(() => {});
  lastSent = null;
  if (tellServer && api) await api.location(false).catch(() => {});
}

/**
 * Start/stop live sharing to match the setting, session and battery. Prefers
 * background updates; falls back to while-the-app-is-open if "Always" is refused.
 */
export function useLiveLocation(opts: { enabled: boolean; batterySaver: boolean; api: ReturnType<typeof client> | null }) {
  const { enabled, batterySaver, api } = opts;
  const [status, setStatus] = useState<LiveLocationStatus>('off');
  const wasSharing = useRef(false);

  useEffect(() => {
    if (!api) return void setStatus('off');
    if (!enabled) {
      stopAll(api, wasSharing.current);
      wasSharing.current = false;
      return void setStatus('off');
    }
    if (batterySaver) {
      stopAll(api, true);
      return void setStatus('paused-battery');
    }
    let cancelled = false;
    let watch: Location.LocationSubscription | null = null;
    (async () => {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) return !cancelled && setStatus('denied');
      const bg = await Location.requestBackgroundPermissionsAsync().catch(() => null);
      if (cancelled) return;
      wasSharing.current = true;
      if (bg?.granted) {
        await Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, TASK_OPTIONS);
        setStatus('on');
      } else {
        watch = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: MIN_MOVE_M, timeInterval: 2 * 60_000 },
          (l) => void upload({ lat: l.coords.latitude, lng: l.coords.longitude, accuracyM: l.coords.accuracy ?? undefined, at: l.timestamp }),
        );
        if (cancelled) watch.remove();
        else setStatus('foreground-only');
      }
    })().catch(() => !cancelled && setStatus('denied'));
    return () => {
      cancelled = true;
      watch?.remove();
    };
  }, [enabled, batterySaver, api]);

  return status;
}
