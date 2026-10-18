import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHuddle, type SosResult } from '../lib/huddle';
import { Button, Card, H, P, useTheme } from '../ui/kit';

const PRESETS = ['Call me', 'Come find me', "Don't call — text me", 'I feel unwell', "I'm leaving, don't come in", 'Someone is bothering me'];
/** Countdown for discreet triggers (huddle://sos), so an accidental shortcut can be cancelled. */
const DISCREET_DELAY_S = 3;
const MAX_NOTE_S = 30;

/**
 * Opened by "Hold for help" (trigger=now), a discreet shortcut (huddle://sos → countdown),
 * or to add details to an SOS already sent.
 */
export default function Sos() {
  const h = useHuddle();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ trigger?: string }>();
  const alreadyActive = h.me?.status === 'sos';
  const [countdown, setCountdown] = useState<number | null>(alreadyActive || params.trigger === 'now' ? null : DISCREET_DELAY_S);
  const [result, setResult] = useState<SosResult | null>(alreadyActive ? 'sent' : null);
  const [sentStatus, setSentStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fired = useRef(false);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder);

  const fire = async () => {
    if (fired.current || alreadyActive) return;
    fired.current = true;
    setResult(await h.sos());
  };

  useEffect(() => {
    if (params.trigger === 'now') fire();
  }, []);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      fire();
      return;
    }
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // Stop automatically at the limit.
  useEffect(() => {
    if (rec.isRecording && rec.durationMillis >= MAX_NOTE_S * 1000) stopAndSend();
  }, [rec.durationMillis]);

  const startRecording = async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) return Alert.alert('Microphone is off', 'You can still pick a status below.');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_NOTE_S });
  };

  const stopAndSend = async () => {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    const uri = recorder.uri;
    if (!uri) return;
    setSending(true);
    try {
      await h.sendVoice(uri, sentStatus ?? undefined);
    } catch (e) {
      Alert.alert('Voice note not sent', `${e instanceof Error ? e.message : e}. Your alert already went out — try a status instead.`);
    } finally {
      setSending(false);
    }
  };

  const sendStatus = async (s: string) => {
    setSentStatus(s);
    try {
      await h.sendStatus(s);
    } catch (e) {
      Alert.alert('Status not sent', e instanceof Error ? e.message : String(e));
    }
  };

  const markSafe = () =>
    Alert.alert("You're safe?", 'Your group (and contacts, if they were texted) will get an all-clear.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: "I'm safe",
        onPress: async () => {
          if (h.me) await h.resolve(h.me.id).catch(() => {});
          router.replace('/session');
        },
      },
    ]);

  if (countdown !== null)
    return (
      <View style={{ flex: 1, backgroundColor: t.danger, justifyContent: 'center', padding: 24, gap: 24 }}>
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800', textAlign: 'center' }}>Alerting your group in {countdown}</Text>
        <Button kind="secondary" title="Cancel" onPress={() => router.replace('/session')} style={{ borderColor: '#fff', backgroundColor: '#ffffff22' }} />
      </View>
    );

  const card = h.me?.card;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
      <Card style={{ borderColor: result === 'failed' ? t.warn : t.danger, borderWidth: 2 }}>
        <H>
          {result === null
            ? 'Sending…'
            : result === 'sent'
              ? 'Your group has been alerted'
              : result === 'sms'
                ? 'No data — opened a text to your contacts'
                : 'Could not reach anyone'}
        </H>
        <P muted>
          {result === 'sent'
            ? 'They have your location and the time. Add details so they know what to do.'
            : result === 'failed'
              ? 'No connection and no contacts to text. If you are in danger, call local emergency services.'
              : ''}
        </P>
      </Card>

      {result === 'sent' && (
        <>
          <Card>
            <H size={18}>Say what you need</H>
            <P muted>Up to {MAX_NOTE_S} seconds. It's transcribed and turned into clear instructions for your friends — only what you actually say.</P>
            <Pressable
              onPress={rec.isRecording ? stopAndSend : startRecording}
              disabled={sending}
              style={{ backgroundColor: rec.isRecording ? t.danger : t.accent, borderRadius: 999, paddingVertical: 20, alignItems: 'center', opacity: sending ? 0.5 : 1 }}
            >
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
                {sending ? 'Sending…' : rec.isRecording ? `Stop & send (${Math.floor(rec.durationMillis / 1000)} s)` : 'Record voice note'}
              </Text>
            </Pressable>
            {card && (card.requestedAction || card.statedLocation || card.avoid) && (
              <P muted>
                Friends see: {[card.statedLocation?.value, card.requestedAction?.value, card.avoid && `don't ${card.avoid.value}`].filter(Boolean).join(' · ')}
              </P>
            )}
          </Card>

          <Card>
            <H size={18}>Or tap a status</H>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {PRESETS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => sendStatus(s)}
                  style={{ borderWidth: 1, borderColor: sentStatus === s ? t.accent : t.line, backgroundColor: sentStatus === s ? t.accent + '22' : t.card, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 }}
                >
                  <Text style={{ color: t.text, fontWeight: '600' }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </Card>
        </>
      )}

      {result === 'sent' && <Button kind="ok" title="I'm safe now" onPress={markSafe} />}
      <Button kind="secondary" title="Back to my huddle" onPress={() => router.replace('/session')} />
    </ScrollView>
  );
}
