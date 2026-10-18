import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';
import type { Contact } from '@huddle/core';
import { useHuddle } from '../lib/huddle';
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
        <H size={18}>Server</H>
        <P muted>Huddle is self-hostable. Use your group's server.</P>
        <Field label="Server URL" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      </Card>

      <Button title="Save" onPress={save} busy={busy} />
    </ScrollView>
  );
}
