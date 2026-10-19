import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { digestToUuid, expectedTokens, HUDDLE_BLE_SERVICE, PROXIMITY_WINDOW_MS, proximityWindow, tokenMessage } from '@huddle/core/proximity';
import Proximity, { type ProximityState } from '../../modules/huddle-proximity';
import type { Client } from './api';

const FLUSH_EVERY_MS = 60_000;
/** Scan in bursts: 10 s every 2 min is plenty for "last seen near". */
const SCAN_MS = 10_000;
const SCAN_PERIOD_MS = 120_000;

export type ProximityStatus = ProximityState | 'off' | 'not-built' | 'denied' | 'paused-battery';

const sha256Hex = (s: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);

async function androidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version < 31) return true; // covered by the location permission
  const P = PermissionsAndroid.PERMISSIONS;
  const res = await PermissionsAndroid.requestMultiple([P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT]);
  return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}

/**
 * Broadcast this phone's rotating ID and note which friends' phones are nearby.
 * Sightings are matched to friends on the phone; only "near <member>" reaches the server.
 */
export function useProximity(opts: {
  enabled: boolean;
  proximityKey: string | null | undefined;
  me: string | undefined;
  memberIds: string[];
  api: Client;
}): ProximityStatus {
  const { enabled, proximityKey, me, api } = opts;
  const members = opts.memberIds.join(',');
  const [status, setStatus] = useState<ProximityStatus>('off');
  const table = useRef(new Map<string, string>());
  const buffer = useRef(new Map<string, number>());

  // Start/stop the radio and rotate our own ID every window.
  useEffect(() => {
    if (!enabled || !proximityKey || !me) return void setStatus('off');
    if (!Proximity) return void setStatus('not-built');
    const radio = Proximity;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tokenNow = async () => digestToUuid(await sha256Hex(tokenMessage(proximityKey, me, proximityWindow(Date.now()))));
    const rotate = async () => {
      if (cancelled) return;
      radio.setToken(await tokenNow());
      table.current = await expectedTokens(proximityKey, members.split(','), Date.now(), sha256Hex);
      timer = setTimeout(rotate, PROXIMITY_WINDOW_MS - (Date.now() % PROXIMITY_WINDOW_MS) + 1000);
    };
    const stateSub = radio.addListener('onState', (e) => setStatus(e.state));
    const seenSub = radio.addListener('onSighting', (s) => {
      const id = table.current.get(s.token);
      if (id && id !== me) buffer.current.set(id, Math.max(buffer.current.get(id) ?? 0, s.at));
    });
    (async () => {
      if (!(await androidPermissions())) return setStatus('denied');
      if (cancelled) return;
      table.current = await expectedTokens(proximityKey, members.split(','), Date.now(), sha256Hex);
      await radio.start(HUDDLE_BLE_SERVICE, await tokenNow(), SCAN_MS, SCAN_PERIOD_MS);
      setStatus(radio.state());
      timer = setTimeout(rotate, PROXIMITY_WINDOW_MS - (Date.now() % PROXIMITY_WINDOW_MS) + 1000);
    })().catch(() => setStatus('unknown'));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stateSub.remove();
      seenSub.remove();
      radio.stop();
    };
  }, [enabled, proximityKey, me, members]);

  // Refresh the friend table when people join, without restarting the radio.
  useEffect(() => {
    if (!proximityKey || !members) return;
    expectedTokens(proximityKey, members.split(','), Date.now(), sha256Hex).then((t) => (table.current = t));
  }, [proximityKey, members]);

  // Upload in batches; keep sightings if offline and try again next time.
  useEffect(() => {
    if (!enabled || !proximityKey) return;
    const flush = async () => {
      if (!buffer.current.size) return;
      const batch = [...buffer.current].map(([memberId, at]) => ({ memberId, at }));
      try {
        await api.proximity(batch);
        for (const { memberId, at } of batch) if (buffer.current.get(memberId) === at) buffer.current.delete(memberId);
      } catch {
        /* retried on the next tick */
      }
    };
    const t = setInterval(flush, FLUSH_EVERY_MS);
    return () => {
      clearInterval(t);
      flush();
    };
  }, [enabled, proximityKey, api]);

  return status;
}
