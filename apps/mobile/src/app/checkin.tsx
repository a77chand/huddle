import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator } from 'react-native';
import { useHuddle } from '../lib/huddle';
import { P, Screen } from '../ui/kit';

/** huddle://checkin — for a home-screen shortcut, Shortcuts automation, or watch complication. */
export default function CheckInLink() {
  const h = useHuddle();
  useEffect(() => {
    if (!h.ready) return;
    if (!h.membership) return void router.replace('/');
    h.checkIn()
      .catch(() => {})
      .finally(() => router.replace('/session'));
  }, [h.ready]);
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator />
      <P muted>Checking in…</P>
    </Screen>
  );
}
