import * as Battery from 'expo-battery';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { GeoFix } from '@huddle/core';

export const ACTION_CHECK_IN = 'checkin_ok';
export const ACTION_RESPOND = 'respond';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** Channels and lock-screen actions. Safe to call repeatedly. */
export async function setupNotifications() {
  if (Platform.OS === 'android') {
    const I = Notifications.AndroidImportance;
    await Notifications.setNotificationChannelAsync('sos', {
      name: 'Someone asked for help',
      importance: I.MAX,
      vibrationPattern: [0, 600, 200, 600, 200, 600],
      bypassDnd: true,
    });
    await Notifications.setNotificationChannelAsync('alert', {
      name: 'Missed check-ins',
      importance: I.HIGH,
      vibrationPattern: [0, 400, 200, 400],
    });
    await Notifications.setNotificationChannelAsync('checkin', {
      name: 'Still okay? prompts',
      importance: I.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    });
    await Notifications.setNotificationChannelAsync('info', { name: 'Group updates', importance: I.DEFAULT });
  }
  await Notifications.setNotificationCategoryAsync('checkin', [
    { identifier: ACTION_CHECK_IN, buttonTitle: "I'm okay", options: { opensAppToForeground: false } },
  ]);
  await Notifications.setNotificationCategoryAsync('alert', [
    { identifier: ACTION_RESPOND, buttonTitle: "I'm on it", options: { opensAppToForeground: true } },
  ]);
}

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const res = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return res.granted;
}

/** Expo push token, or null in a simulator / without an EAS project id. */
export async function pushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return data;
  } catch {
    return null;
  }
}

const PROMPT_IDS = ['huddle-prompt', 'huddle-nudge'] as const;

/**
 * Schedule the "Still okay?" prompt and the louder follow-up on the phone itself,
 * so they fire with no signal. The server separately decides when to tell the group.
 */
export async function schedulePrompts(nextDueAt: number, graceMin: number) {
  await cancelPrompts();
  const now = Date.now();
  const items = [
    { id: PROMPT_IDS[0], at: nextDueAt, title: 'Still okay?', body: 'Tap "I\'m okay" to check in.' },
    {
      id: PROMPT_IDS[1],
      at: nextDueAt + (graceMin * 60_000) / 2,
      title: 'Check-in overdue',
      body: `Check in now — your group will be told in ${Math.ceil(graceMin / 2)} min.`,
    },
  ];
  for (const it of items) {
    if (it.at <= now) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: it.id,
      content: {
        title: it.title,
        body: it.body,
        sound: true,
        categoryIdentifier: 'checkin',
        interruptionLevel: 'timeSensitive',
        data: { kind: 'prompt' },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: it.at, channelId: 'checkin' },
    });
  }
}

export async function cancelPrompts() {
  await Promise.all(PROMPT_IDS.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})));
}

/**
 * Best available location within a few seconds. Falls back to the last known
 * fix (its own timestamp is kept, so friends see how old it is).
 */
export async function currentFix(timeoutMs = 6000): Promise<GeoFix | undefined> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (!asked.granted) return undefined;
    }
    const toFix = (l: Location.LocationObject): GeoFix => ({
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      accuracyM: l.coords.accuracy ?? undefined,
      at: l.timestamp,
    });
    // Never pop Android's "Location Accuracy" settings dialog — certainly not mid-SOS. Use what's available.
    const fresh = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false }).then(toFix);
    const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs));
    const fix = await Promise.race([fresh, timeout]);
    if (fix) return fix;
    const last = await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 });
    return last ? toFix(last) : undefined;
  } catch {
    return undefined;
  }
}

export async function batteryLevel(): Promise<number | undefined> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? level : undefined;
  } catch {
    return undefined;
  }
}
