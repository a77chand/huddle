import * as Battery from 'expo-battery';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { Client } from './api';

/**
 * Opt-in field-test mode: every 10 minutes, record battery and radio state and
 * upload it, so a night out produces real numbers (battery drain per hour with
 * each feature on/off, Bluetooth detection, alert latency). Nothing personal:
 * no location, no audio.
 */
const SAMPLE_EVERY_MS = 10 * 60_000;

let sightings = 0;
/** Called by the proximity hook for each matched friend sighting. */
export function countSighting() {
  sightings++;
}

export function useFieldTest(opts: { enabled: boolean; api: Client | null; proximity: string; liveLocation: string }) {
  const { enabled, api } = opts;
  const latest = useRef(opts);
  latest.current = opts;
  const buffer = useRef<Record<string, unknown>[]>([]);

  useEffect(() => {
    if (!enabled || !api) return;
    const sample = async () => {
      const [level, state, low] = await Promise.all([
        Battery.getBatteryLevelAsync().catch(() => -1),
        Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
        Battery.isLowPowerModeEnabledAsync().catch(() => false),
      ]);
      buffer.current.push({
        at: Date.now(),
        battery: level >= 0 ? level : null,
        charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
        lowPower: low,
        proximity: latest.current.proximity,
        liveLocation: latest.current.liveLocation,
        appState: AppState.currentState,
        sightings,
      });
      sightings = 0;
      try {
        await api.diagnostics(buffer.current);
        buffer.current = [];
      } catch {
        buffer.current = buffer.current.slice(-100); // keep trying next time
      }
    };
    sample();
    const t = setInterval(sample, SAMPLE_EVERY_MS);
    const sub = AppState.addEventListener('change', () => void sample());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [enabled, api]);
}
