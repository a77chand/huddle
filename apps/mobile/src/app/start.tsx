import { Link, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useHuddle } from '../lib/huddle';
import { Button, Card, Field, H, P, useTheme } from '../ui/kit';

const DURATIONS = [4, 8, 12, 24];

/** Start a night-out session or join one with a code (also reached via huddle://start?code=XXXXXX). */
export default function Start() {
  const h = useHuddle();
  const t = useTheme();
  const params = useLocalSearchParams<{ code?: string }>();
  const [name, setName] = useState('');
  const [hours, setHours] = useState(8);
  const [code, setCode] = useState(params.code ?? '');
  const [busy, setBusy] = useState<'start' | 'join' | null>(null);

  const go = async (kind: 'start' | 'join') => {
    setBusy(kind);
    try {
      if (kind === 'start') await h.start(name.trim() || 'Night out', hours);
      else await h.join(code.trim());
      router.replace('/session');
    } catch (e) {
      Alert.alert(kind === 'start' ? 'Could not start' : 'Could not join', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 4, paddingVertical: 8 }}>
        <H size={28}>Going out?</H>
        <P muted>Start a huddle with your friends. Everyone checks in on their own schedule, and the group sees who is accounted for.</P>
      </View>

      <Card>
        <H size={18}>Start a huddle</H>
        <Field label="What's the plan?" value={name} onChangeText={setName} placeholder="Concert, Friday drinks, festival…" />
        <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>Ends automatically after</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {DURATIONS.map((d) => (
            <Pressable
              key={d}
              onPress={() => setHours(d)}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 10,
                alignItems: 'center',
                backgroundColor: hours === d ? t.accent : t.bg,
                borderWidth: 1,
                borderColor: hours === d ? t.accent : t.line,
              }}
            >
              <Text style={{ color: hours === d ? '#fff' : t.text, fontWeight: '600' }}>{d} h</Text>
            </Pressable>
          ))}
        </View>
        <Button title="Start" onPress={() => go('start')} busy={busy === 'start'} />
      </Card>

      <Card>
        <H size={18}>Join friends</H>
        <Field label="Code from a friend" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="7X5S96" maxLength={8} />
        <Button title="Join" onPress={() => go('join')} busy={busy === 'join'} disabled={code.trim().length < 6} />
      </Card>

      <Link href="/setup" style={{ color: t.accent, textAlign: 'center', padding: 8 }}>
        Edit your details & check-in schedule
      </Link>
    </ScrollView>
  );
}
