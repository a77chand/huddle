import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardRow } from '@huddle/core';
import { useHuddle } from '../lib/huddle';
import { ago, Button, Card, clock, H, P, Pill, STATUS_LABEL, statusColor, useTheme } from '../ui/kit';

const HOLD_MS = 1200;

const PROXIMITY_HINT: Partial<Record<string, string>> = {
  poweredOff: 'Bluetooth is off — friends can’t see when you’re nearby.',
  unauthorized: 'Bluetooth permission is off — “last seen near” is paused.',
  denied: 'Bluetooth permission is off — “last seen near” is paused.',
  'not-built': '“Last seen near” needs a development build (not Expo Go).',
};

const LIVE_HINT: Partial<Record<string, string>> = {
  on: 'Sharing live location with your group.',
  'foreground-only': 'Sharing live location while Huddle is open — allow “Always” for background.',
  denied: 'Live location is on, but location permission is off.',
};

export default function Session() {
  const h = useHuddle();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (h.ready && !h.membership) router.replace('/start');
  }, [h.ready, h.membership]);

  const v = h.view;
  const me = h.me;
  if (!v || !me) return <View style={{ flex: 1, backgroundColor: t.bg }} />;

  const others = v.board.rows.filter((r) => r.id !== v.me && r.status !== 'left');
  const attention = others.filter((r) => r.needsAttention);
  const fine = others.filter((r) => !r.needsAttention);
  const dueIn = Math.round((me.nextDueAt - now) / 60_000);

  const checkIn = async () => {
    setBusy(true);
    try {
      await h.checkIn();
    } catch (e) {
      Alert.alert('Check-in failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const snooze = () =>
    Alert.alert('Pause check-ins', 'Your group still sees you as okay until then.', [
      ...[30, 60, 120].map((m) => ({ text: m < 60 ? `${m} min` : `${m / 60} h`, onPress: () => h.snooze(m).catch((e) => Alert.alert('Could not pause', e.message)) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);

  const menu = () =>
    Alert.alert(v.board.name, undefined, [
      { text: 'Edit my check-in schedule', onPress: () => router.push('/setup') },
      {
        text: 'Leave this huddle',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Leave?', 'Your group will stop seeing your check-ins and location.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Leave', style: 'destructive', onPress: () => h.leave() },
          ]),
      },
      { text: 'Close', style: 'cancel' },
    ]);

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await h.refresh();
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <H size={26}>{v.board.name}</H>
          <Text style={{ color: t.muted }}>
            <Text style={{ color: h.connection === 'live' ? t.ok : t.warn }}>●</Text>{' '}
            {h.connection === 'live' ? 'Live' : h.connection === 'polling' ? 'Reconnecting…' : 'Offline'} · {v.board.counts.accountedFor}/
            {v.board.counts.present} accounted for · ends {clock(v.board.endsAt)}
          </Text>
          {v.board.e2e && (
            <Text style={{ color: h.encryptionReady ? t.ok : t.warn, fontSize: 12 }}>
              {h.encryptionReady
                ? '🔒 End-to-end encrypted: locations and messages are readable only by this group.'
                : '🔒 Waiting for a friend’s phone to share the group key…'}
            </Text>
          )}
          {h.batterySaver ? (
            <Text style={{ color: t.muted, fontSize: 12 }}>Battery saver: Bluetooth and live location paused. Check-ins and SOS still work.</Text>
          ) : (
            [PROXIMITY_HINT[h.proximity], LIVE_HINT[h.liveLocation]].filter(Boolean).map((x) => (
              <Text key={x} style={{ color: t.muted, fontSize: 12 }}>
                {x}
              </Text>
            ))
          )}
        </View>
        <Pressable onPress={menu} hitSlop={12} accessibilityLabel="Huddle menu">
          <Text style={{ color: t.accent, fontSize: 28 }}>⋯</Text>
        </Pressable>
      </View>

      {h.pendingCheckIn && (
        <Card style={{ borderColor: t.warn }}>
          <P>Your check-in hasn't reached the server — no connection. Retrying every 15 s.</P>
          <P muted>If it stays offline past your grace period, your group will see you as unreachable.</P>
        </Card>
      )}

      {attention.map((r) => (
        <AttentionCard key={r.id} row={r} headline={v.incidents.find((i) => i.memberId === r.id)?.headline} names={v.board.rows} />
      ))}

      <Card>
        {me.status === 'sos' ? (
          <>
            <Pill label="You asked for help" color={t.danger} />
            <P>Your group has been alerted{me.responders.length ? ` — ${me.responders.map((x) => v.board.rows.find((r) => r.id === x.memberId)?.name).join(', ')} responding` : ''}.</P>
            <Button kind="danger" title="Add details or mark safe" onPress={() => router.push('/sos')} />
          </>
        ) : (
          <>
            <Text style={{ color: t.muted, fontWeight: '600' }}>
              {me.status === 'ok'
                ? `Next check-in ${dueIn <= 0 ? 'now' : `in ${dueIn} min`} (${clock(me.nextDueAt)})`
                : me.status === 'due'
                  ? 'Check-in due — tap to let your group know'
                  : 'Your group was told you are unreachable'}
            </Text>
            <Button kind="ok" title="I'm okay" onPress={checkIn} busy={busy} style={{ paddingVertical: 22 }} />
            {me.status === 'ok' && <Button kind="secondary" title="Pause check-ins" onPress={snooze} />}
          </>
        )}
      </Card>

      {me.status !== 'sos' && <HoldForHelp onFire={() => router.push({ pathname: '/sos', params: { trigger: 'now' } })} />}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <H size={18}>Friends</H>
        {v.joinCode && (
          <Pressable
            onPress={() =>
              Share.share({
                message: `Join my huddle "${v.board.name}": code ${v.joinCode}${h.inviteLink ? ` — ${h.inviteLink}` : ''}`,
              })
            }
            hitSlop={8}
          >
            <Text style={{ color: t.accent, fontWeight: '600' }}>Invite · {v.joinCode}</Text>
          </Pressable>
        )}
      </View>
      {fine.length === 0 && attention.length === 0 && <P muted>No one else yet. Share the code so friends can join.</P>}
      {fine.map((r) => (
        <Pressable key={r.id} onPress={() => router.push(`/member/${r.id}`)}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ gap: 4, flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{r.name}</Text>
              <Text style={{ color: t.muted, fontSize: 13 }}>
                Checked in {ago(r.lastCheckInAt, now)}
                {r.lastNear && r.lastNear.memberId === v.me && now - r.lastNear.at < 10 * 60_000 ? ' · nearby' : ''}
                {r.liveLocation ? ' · live location' : ''}
                {r.battery && r.battery.level < 0.2 ? ` · 🔋 ${Math.round(r.battery.level * 100)}%` : ''}
              </Text>
            </View>
            <Pill label={STATUS_LABEL[r.status]} color={statusColor(t, r.status)} />
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function AttentionCard({ row, headline, names }: { row: BoardRow; headline?: string; names: BoardRow[] }) {
  const t = useTheme();
  const color = statusColor(t, row.status);
  const responders = row.responders.map((x) => names.find((n) => n.id === x.memberId)?.name).filter(Boolean);
  return (
    <Pressable onPress={() => router.push(`/member/${row.id}`)}>
      <Card style={{ borderColor: color, borderWidth: 2 }}>
        <Pill label={row.lowBattery && row.status === 'ok' ? 'Battery almost dead' : STATUS_LABEL[row.status]} color={color} />
        <H size={18}>{headline ?? row.name}</H>
        <P muted>{responders.length ? `${responders.join(', ')} responding` : 'Nobody has said they are on it yet'} · tap for details</P>
      </Card>
    </Pressable>
  );
}

/** Press and hold so a pocket-tap doesn't alert everyone. */
function HoldForHelp({ onFire }: { onFire: () => void }) {
  const t = useTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const anim = useRef<Animated.CompositeAnimation | null>(null);
  const start = () => {
    anim.current = Animated.timing(progress, { toValue: 1, duration: HOLD_MS, useNativeDriver: false });
    anim.current.start(({ finished }) => {
      if (finished) {
        progress.setValue(0);
        onFire();
      }
    });
  };
  const cancel = () => {
    anim.current?.stop();
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };
  return (
    <Pressable onPressIn={start} onPressOut={cancel} accessibilityRole="button" accessibilityLabel="Hold to ask your group for help">
      <View style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: t.danger + '22', borderWidth: 2, borderColor: t.danger }}>
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            backgroundColor: t.danger,
            width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }}
        />
        <Text style={{ color: t.text, textAlign: 'center', fontSize: 18, fontWeight: '800', paddingVertical: 20 }}>Hold for help</Text>
      </View>
    </Pressable>
  );
}
