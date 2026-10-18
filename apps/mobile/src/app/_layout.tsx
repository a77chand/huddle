import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { ACTION_CHECK_IN, ACTION_RESPOND } from '../lib/device';
import { HuddleProvider, useHuddle } from '../lib/huddle';
import { useTheme } from '../ui/kit';

export default function Layout() {
  const t = useTheme();
  return (
    <HuddleProvider>
      <StatusBar style="auto" />
      <NotificationActions />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.bg },
          headerTintColor: t.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="setup" options={{ title: 'Your details' }} />
        <Stack.Screen name="start" options={{ title: 'Huddle' }} />
        <Stack.Screen name="session" options={{ headerShown: false }} />
        <Stack.Screen name="member/[id]" options={{ title: '', presentation: 'modal' }} />
        <Stack.Screen name="sos" options={{ title: 'Help', presentation: 'fullScreenModal', headerShown: false }} />
        <Stack.Screen name="checkin" options={{ headerShown: false }} />
      </Stack>
    </HuddleProvider>
  );
}

/** Lock-screen buttons: "I'm okay" checks in without opening the app; "I'm on it" claims the alert. */
function NotificationActions() {
  const h = useHuddle();
  const handled = useRef(new Set<string>());
  const last = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!last || !h.ready || !h.membership) return;
    const id = last.notification.request.identifier + last.actionIdentifier;
    if (handled.current.has(id)) return;
    handled.current.add(id);
    // Ignore stale responses replayed on a cold start.
    if (Date.now() - last.notification.date > 60 * 60_000) return;
    const data = last.notification.request.content.data as { kind?: string; memberId?: string } | undefined;
    if (last.actionIdentifier === ACTION_CHECK_IN) {
      h.checkIn().catch(() => {});
    } else if (last.actionIdentifier === ACTION_RESPOND && data?.memberId) {
      h.ack(data.memberId).catch(() => {});
      router.push(`/member/${data.memberId}`);
    } else if (last.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
      if (data?.memberId && data.memberId !== h.membership.memberId) router.push(`/member/${data.memberId}`);
      else router.navigate('/session');
    }
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }, [last, h.ready, h.membership]);

  return null;
}
