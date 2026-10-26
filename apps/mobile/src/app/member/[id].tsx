import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, ScrollView, Text, View } from 'react-native';
import { fingerprint } from '@huddle/core/e2e';
import { useHuddle } from '../../lib/huddle';
import { ago, Button, Card, clock, H, P, Pill, STATUS_LABEL, statusColor, useTheme } from '../../ui/kit';

/** One friend: what is known, what isn't, and what to do — plus the coordination buttons. */
export default function Member() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const h = useHuddle();
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const v = h.view;
  const row = v?.board.rows.find((r) => r.id === id);
  if (!v || !row) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const incident = v.incidents.find((i) => i.memberId === id);
  const iResponding = row.responders.some((r) => r.memberId === v.me);
  const name = (mid: string) => v.board.rows.find((r) => r.id === mid)?.name ?? 'Someone';

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Could not do that', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const loc = row.lastLocation;
  const mapUrl = loc ? `https://maps.google.com/?q=${loc.lat},${loc.lng}` : null;

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Pill label={STATUS_LABEL[row.status]} color={statusColor(t, row.status)} />
        <H size={24}>{incident?.headline ?? row.name}</H>
      </View>

      {incident ? (
        <>
          <Card>
            <H size={16}>What we know</H>
            {incident.known.map((k, i) => (
              <P key={i}>• {k}</P>
            ))}
          </Card>
          {incident.unknown.length > 0 && (
            <Card>
              <H size={16}>What we don't know</H>
              {incident.unknown.map((k, i) => (
                <P key={i} muted>
                  • {k}
                </P>
              ))}
            </Card>
          )}
          <Card>
            <H size={16}>What you can do</H>
            {incident.nextSteps.map((k, i) => (
              <P key={i}>
                {i + 1}. {k}
              </P>
            ))}
          </Card>
          {row.card?.transcript ? (
            <Card>
              <H size={16}>Their voice note</H>
              <P muted>“{row.card.transcript}”</P>
              <Text style={{ color: t.muted, fontSize: 12 }}>Transcribed and structured by {row.card.extractor}. Every detail above quotes their words.</Text>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <P>Checked in {ago(row.lastCheckInAt)} ({clock(row.lastCheckInAt)}).</P>
          <P muted>Next check-in due {clock(row.nextDueAt)}.</P>
          {loc && <P muted>Location shared {ago(loc.at)}.</P>}
          {v.board.e2e && row.publicKey && h.myPublicKey && row.id !== v.me && (
            <P muted>
              Safety codes — compare in person to be sure no one is intercepting: theirs {fingerprint(row.publicKey)}, yours{' '}
              {fingerprint(h.myPublicKey)}.
            </P>
          )}
          {row.lastNear && (
            <P muted>
              Last near {row.lastNear.memberId === v.me ? 'you' : row.lastNear.name} {ago(row.lastNear.at)} (Bluetooth).
            </P>
          )}
        </Card>
      )}

      {row.phone && <Button title={`Call ${row.name}`} onPress={() => Linking.openURL(`tel:${row.phone}`)} />}
      {row.phone && <Button kind="secondary" title={`Text ${row.name}`} onPress={() => Linking.openURL(`sms:${row.phone}`)} />}
      {mapUrl && <Button kind="secondary" title={`Open last location (${ago(loc!.at)})`} onPress={() => Linking.openURL(mapUrl)} />}

      {row.needsAttention && id !== v.me && (
        <>
          {!iResponding && <Button title="I'm on it" onPress={() => act('ack', () => h.ack(id))} busy={busy === 'ack'} />}
          {iResponding && <P muted>You told the group you're responding.</P>}
          {row.responders.filter((r) => r.memberId !== v.me).map((r) => (
            <P key={r.memberId} muted>
              {name(r.memberId)} is responding (since {clock(r.at)}).
            </P>
          ))}
          {row.hasContacts && !row.contactsAlerted && (
            <Button
              kind="secondary"
              title="Text their emergency contacts"
              busy={busy === 'esc'}
              onPress={() =>
                Alert.alert('Text their contacts?', `Their emergency contacts get a summary of what is known about ${row.name}.`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Send', onPress: () => act('esc', () => h.escalate(id)) },
                ])
              }
            />
          )}
          <Button
            kind="ok"
            title={`I found ${row.name} — they're safe`}
            busy={busy === 'resolve'}
            onPress={() => act('resolve', async () => {
              await h.resolve(id);
              router.back();
            })}
          />
        </>
      )}
      {v.board.hostId === v.me && id !== v.me && row.status !== 'left' && (
        <Button
          kind="secondary"
          title={`Remove ${row.name} from the huddle`}
          busy={busy === 'remove'}
          onPress={() =>
            Alert.alert(`Remove ${row.name}?`, 'They stop seeing the group, and nothing shared from now on can be read by them.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () =>
                  act('remove', async () => {
                    await h.remove(id);
                    router.back();
                  }),
              },
            ])
          }
        />
      )}
    </ScrollView>
  );
}
