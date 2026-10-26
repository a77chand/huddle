import * as Location from 'expo-location';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { requestNotificationPermission } from '../lib/device';
import { Button, Card, H, P, useTheme } from '../ui/kit';

export const ONBOARDED_KEY = 'huddle.onboarded';
const PRIVACY_URL = 'https://github.com/a77chand/huddle/blob/main/docs/PRIVACY.md';

interface Step {
  emoji: string;
  title: string;
  body: string[];
  /** Asked here, right after the explanation; nothing is requested before the person understands why. */
  ask?: { label: string; run: () => Promise<boolean> };
}

const STEPS: Step[] = [
  {
    emoji: '👋',
    title: 'Look out for each other',
    body: [
      'Start a huddle with friends for a night out. Everyone checks in on their own schedule, and the group always sees who is accounted for.',
      'If someone goes quiet, friends see what is known, what isn’t, and what to do — “unreachable”, never a false alarm.',
      'Huddle is not an emergency service. If someone may be in danger, call your local emergency number.',
    ],
  },
  {
    emoji: '🔔',
    title: 'Notifications',
    body: [
      'Huddle asks “Still okay?” on your schedule — even with no signal — and tells you when a friend needs you.',
      'You can answer from the lock screen without opening the app.',
    ],
    ask: { label: 'Allow notifications', run: requestNotificationPermission },
  },
  {
    emoji: '📍',
    title: 'Location, only when it helps',
    body: [
      'Your location is shared with your group when you check in or ask for help — not tracked all night, unless you turn on live location.',
      'It’s end-to-end encrypted: only your friends can see it, not the server.',
    ],
    ask: { label: 'Allow location', run: async () => (await Location.requestForegroundPermissionsAsync()).granted },
  },
  {
    emoji: '📡',
    title: 'Bluetooth and microphone',
    body: [
      'Bluetooth lets friends’ phones notice when they’re near each other, using anonymous IDs that change every 15 minutes. Your phone asks when you join a huddle.',
      'The microphone is only used when you choose to record a voice note with an alert.',
    ],
  },
  {
    emoji: '🔒',
    title: 'Private by design',
    body: [
      'No accounts. Everything about a huddle is deleted a day after it ends.',
      'Locations and voice notes are encrypted on your phone. You can turn every optional feature off in your details.',
    ],
  },
];

export default function Onboarding() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [i, setI] = useState(0);
  const [asked, setAsked] = useState<Record<number, boolean>>({});
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;

  const next = async () => {
    if (!last) return setI(i + 1);
    await SecureStore.setItemAsync(ONBOARDED_KEY, '1').catch(() => {});
    router.replace('/setup');
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ flexGrow: 1, padding: 20, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }} accessibilityLabel={`Step ${i + 1} of ${STEPS.length}`}>
        {STEPS.map((_, k) => (
          <View key={k} style={{ width: k === i ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: k <= i ? t.accent : t.line }} />
        ))}
      </View>
      <Text style={{ fontSize: 56, textAlign: 'center' }} accessibilityElementsHidden>
        {step.emoji}
      </Text>
      <H size={26}>{step.title}</H>
      <Card>
        {step.body.map((b, k) => (
          <P key={k}>{b}</P>
        ))}
      </Card>
      <View style={{ flex: 1 }} />
      {step.ask && !asked[i] ? (
        <>
          <Button
            title={step.ask.label}
            onPress={async () => {
              await step.ask!.run().catch(() => false);
              setAsked({ ...asked, [i]: true });
              next();
            }}
          />
          <Button kind="secondary" title="Not now" onPress={next} />
        </>
      ) : (
        <Button title={last ? 'Set up my details' : 'Next'} onPress={next} />
      )}
      {last && <Button kind="secondary" title="Read the privacy policy" onPress={() => Linking.openURL(PRIVACY_URL)} />}
    </ScrollView>
  );
}
