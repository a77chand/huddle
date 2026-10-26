import { Redirect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { useHuddle } from '../lib/huddle';
import { Screen } from '../ui/kit';
import { ONBOARDED_KEY } from './onboarding';

export default function Index() {
  const { ready, profile, membership } = useHuddle();
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(ONBOARDED_KEY)
      .then((v) => setOnboarded(v === '1'))
      .catch(() => setOnboarded(false));
  }, []);
  if (!ready || onboarded === null)
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <ActivityIndicator />
      </Screen>
    );
  if (!profile) return <Redirect href={onboarded ? '/setup' : '/onboarding'} />;
  if (!membership) return <Redirect href="/start" />;
  return <Redirect href="/session" />;
}
