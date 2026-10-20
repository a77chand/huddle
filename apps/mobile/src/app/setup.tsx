import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';
import type { Contact } from '@huddle/core';
import { useHuddle } from '../lib/huddle';
import { allInstalled, download, MODELS, removeModels } from '../lib/ondevice';
import { DEFAULT_POLICY, DEFAULT_SERVER } from '../lib/storage';
import { Button, Card, Field, H, P, useTheme } from '../ui/kit';

const E164 = /^\+[1-9]\d{6,14}$/;

/** Profile + check-in policy. First run, and later from the session's settings. */
export default function Setup() {
  const h = useHuddle();
  const t = useTheme();
  const p = h.profile;
  const policy = p?.policy ?? DEFAULT_POLICY;
  const [name, setName] = useState(p?.name ?? '');
  const [phone, setPhone] = useState(p?.phone ?? '');
  const [server, setServer] = useState(p?.serverUrl ?? DEFAULT_SERVER);
  const [interval, setIntervalMin] = useState(String(policy.intervalMin));
  const [grace, setGrace] = useState(String(policy.graceMin));
  const [escalate, setEscalate] = useState(policy.escalateAfterMin === null ? '' : String(policy.escalateAfterMin));
  const [sosContacts, setSosContacts] = useState(policy.sosNotifiesContacts);
  const [shareProximity, setShareProximity] = useState(p?.shareProximity !== false);
  const [shareLiveLocation, setShareLiveLocation] = useState(p?.shareLiveLocation === true);
  const [onDeviceAI, setOnDeviceAI] = useState(p?.onDeviceAI === true);
  const [modelsReady, setModelsReady] = useState(() => allInstalled());
  const [progress, setProgress] = useState<number | null>(null);
  const modelMB = Math.round(MODELS.reduce((n, m) => n + m.bytes, 0) / 1e6);
  const fetchModels = async () => {
    setProgress(0);
    try {
      await download(setProgress);
      setModelsReady(true);
      setOnDeviceAI(true);
    } catch (e) {
      Alert.alert('Download failed', `${e instanceof Error ? e.message : e}. Try again on Wi-Fi.`);
    } finally {
      setProgress(null);
      h.refreshOnDevice();
    }
  };
  const [contacts, setContacts] = useState<Contact[]>(policy.contacts.length ? policy.contacts : [{ name: '', phone: '' }]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const cleaned = contacts.filter((c) => c.name.trim() || c.phone.trim()).map((c) => ({ name: c.name.trim(), phone: c.phone.replace(/[\s()-]/g, '') }));
    const problems = [
      !name.trim() && 'Add your name.',
      phone && !E164.test(phone.replace(/[\s()-]/g, '')) && 'Your phone needs the country code, like +14155550123.',
      cleaned.some((c) => !c.name || !E164.test(c.phone)) && 'Each contact needs a name and a phone with country code.',
      !(+interval >= 5 && +interval <= 1440) && 'Check-in interval must be 5–1440 minutes.',
      !(+grace >= 1 && +grace <= 120) && 'Grace period must be 1–120 minutes.',
      escalate && !(+escalate >= 1 && +escalate <= 1440) && 'Escalation must be 1–1440 minutes, or empty for never.',
    ].filter(Boolean);
    if (problems.length) return Alert.alert('Check your details', problems.join('\n'));
    const next = {
      name: name.trim(),
      phone: phone.replace(/[\s()-]/g, ''),
      serverUrl: server.trim().replace(/\/$/, ''),
      shareProximity,
      shareLiveLocation,
      onDeviceAI: onDeviceAI && modelsReady,
      policy: {
        intervalMin: +interval,
        graceMin: +grace,
        escalateAfterMin: escalate ? +escalate : null,
        contacts: cleaned,
        sosNotifiesContacts: sosContacts,
      },
    };
    setBusy(true);
    try {
      if (h.membership) await h.updatePolicy(next.policy);
      await h.saveProfile(next);
      router.replace(h.membership ? '/session' : '/start');
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Card>
        <H size={18}>You</H>
        <Field label="Name your friends know" value={name} onChangeText={setName} autoComplete="name" />
        <Field label="Your phone (optional, so friends can tap to call)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+14155550123" />
      </Card>

      <Card>
        <H size={18}>Check-ins</H>
        <P muted>Huddle asks “Still okay?” on this schedule. A missed check-in is a reason to look, not proof of an emergency.</P>
        <Field label="Ask me every (minutes)" value={interval} onChangeText={setIntervalMin} keyboardType="number-pad" />
        <Field label="Then wait before telling my group (minutes)" value={grace} onChangeText={setGrace} keyboardType="number-pad" />
        <Field
          label="If nobody in the group responds, text my contacts after (minutes, empty = never)"
          value={escalate}
          onChangeText={setEscalate}
          keyboardType="number-pad"
        />
      </Card>

      <Card>
        <H size={18}>Emergency contacts</H>
        <P muted>People outside the app — a parent, partner, roommate. They get a text with what is known, never a vague “SOS”.</P>
        {contacts.map((c, i) => (
          <View key={i} style={{ gap: 6 }}>
            <Field label={`Contact ${i + 1} name`} value={c.name} onChangeText={(v) => setContacts(contacts.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
            <Field
              label="Phone with country code"
              value={c.phone}
              keyboardType="phone-pad"
              placeholder="+14155550123"
              onChangeText={(v) => setContacts(contacts.map((x, j) => (j === i ? { ...x, phone: v } : x)))}
            />
          </View>
        ))}
        {contacts.length < 3 && <Button kind="secondary" title="Add another contact" onPress={() => setContacts([...contacts, { name: '', phone: '' }])} />}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Text them immediately when I press SOS</Text>
          <Switch value={sosContacts} onValueChange={setSosContacts} />
        </View>
      </Card>

      <Card>
        <H size={18}>Bluetooth “last seen near”</H>
        <P muted>
          While you're in a huddle, your phone broadcasts an anonymous ID that changes every 15 minutes. Only your group can recognise it. If someone goes
          quiet, friends can see whose phone was last near theirs, even with no signal. No location is sent.
        </P>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Share Bluetooth proximity with my group</Text>
          <Switch value={shareProximity} onValueChange={setShareProximity} />
        </View>
      </Card>

      <Card>
        <H size={18}>Live location</H>
        <P muted>
          Off by default: Huddle normally shares where you are only when you check in or ask for help. Turn this on to share your position continuously
          during a huddle, like map location sharing. It uses low-power location and only updates after you move, and your phone will ask for
          “Always” location access.
        </P>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Share live location during huddles</Text>
          <Switch value={shareLiveLocation} onValueChange={setShareLiveLocation} />
        </View>
      </Card>

      <Card>
        <H size={18}>On-device AI</H>
        <P muted>
          Turn voice notes into instructions on this phone instead of the server: the recording never leaves your phone and it works with no signal.
          Uses open-weight Whisper and Huddle's own fine-tuned 0.5B model (one-time {modelMB} MB download — use Wi-Fi).
        </P>
        {modelsReady ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Process voice notes on this phone</Text>
              <Switch value={onDeviceAI} onValueChange={setOnDeviceAI} />
            </View>
            {h.onDeviceTimings.length > 0 && (
              <P muted>
                Last {h.onDeviceTimings.length} notes: transcribe ~
                {Math.round(h.onDeviceTimings.reduce((n, x) => n + x.transcribeMs, 0) / h.onDeviceTimings.length)} ms, understand ~
                {Math.round(h.onDeviceTimings.reduce((n, x) => n + x.extractMs, 0) / h.onDeviceTimings.length)} ms.
              </P>
            )}
            <Button
              kind="secondary"
              title="Delete downloaded models"
              onPress={async () => {
                await removeModels();
                setModelsReady(false);
                setOnDeviceAI(false);
                h.refreshOnDevice();
              }}
            />
          </>
        ) : (
          <Button
            title={progress === null ? `Download models (${modelMB} MB)` : `Downloading… ${Math.round(progress * 100)}%`}
            onPress={fetchModels}
            busy={false}
            disabled={progress !== null}
          />
        )}
      </Card>

      <P muted style={{ paddingHorizontal: 4 }}>
        To save battery, Bluetooth and live location pause in Low Power Mode or below 20%. Check-ins, SOS and the low-battery alert always keep working.
      </P>

      <Card>
        <H size={18}>Server</H>
        <P muted>Huddle is self-hostable. Use your group's server.</P>
        <Field label="Server URL" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      </Card>

      <Button title="Save" onPress={save} busy={busy} />
    </ScrollView>
  );
}
