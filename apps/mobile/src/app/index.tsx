import { Redirect } from 'expo-router';
import { ActivityIndicator } from 'react-native';
import { useHuddle } from '../lib/huddle';
import { Screen } from '../ui/kit';

export default function Index() {
  const { ready, profile, membership } = useHuddle();
  if (!ready)
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <ActivityIndicator />
      </Screen>
    );
  if (!profile) return <Redirect href="/setup" />;
  if (!membership) return <Redirect href="/start" />;
  return <Redirect href="/session" />;
}
