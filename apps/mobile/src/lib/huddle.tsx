import * as Battery from 'expo-battery';
import * as Haptics from 'expo-haptics';
import * as SMS from 'expo-sms';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AppState } from 'react-native';
import type { BoardRow, CheckInPolicy } from '@huddle/core';
import { ApiError, client, OfflineError, type View } from './api';
import { batteryLevel, cancelPrompts, currentFix, pushToken, requestNotificationPermission, schedulePrompts, setupNotifications } from './device';
import { useFieldTest } from './fieldTest';
import { useLiveLocation, type LiveLocationStatus } from './liveLocation';
import { allInstalled, EXTRACTOR_NAME, processVoiceNote } from './ondevice';
import { groundCard, type AlertCard, type GeoFix } from '@huddle/core';
import {
  decryptView,
  forgetKeys,
  inviteKeyParam,
  loadKeys,
  newKeyPair,
  parseInviteKey,
  proximityKeyFor,
  saveKeys,
  sealer,
  syncKeys,
  type SessionKeys,
} from './keys';
import type { LocationPayload } from './api';
import { useProximity, type ProximityStatus } from './proximity';
import { storage, type Membership, type Profile } from './storage';

type Connection = 'live' | 'polling' | 'offline';
export type SosResult = 'sent' | 'sms' | 'failed';

interface Huddle {
  ready: boolean;
  profile: Profile | null;
  membership: Membership | null;
  view: View | null;
  me: BoardRow | null;
  connection: Connection;
  /** A check-in that hasn't reached the server yet. */
  pendingCheckIn: boolean;
  proximity: ProximityStatus;
  liveLocation: LiveLocationStatus;
  /** Low Power Mode or under 20%: Bluetooth and live location pause; check-ins and SOS never do. */
  batterySaver: boolean;
  /** On-device AI is switched on and its models are downloaded. */
  onDeviceReady: boolean;
  /** Recent on-device timings, for the benchmark screen. */
  onDeviceTimings: { transcribeMs: number; extractMs: number; audioMs?: number }[];
  refreshOnDevice(): void;
  saveProfile(p: Profile): Promise<void>;
  start(name: string, durationHours: number): Promise<void>;
  /** `inviteKey` comes from an invite link, so link-joiners can read the group right away. */
  join(code: string, inviteKey?: string): Promise<void>;
  /** Encrypted huddle: this phone holds the current group key. */
  encryptionReady: boolean;
  /** Link that carries the join code and (for encrypted huddles) the group key. */
  inviteLink: string | null;
  myPublicKey: string | null;
  checkIn(): Promise<void>;
  sos(status?: string): Promise<SosResult>;
  sendStatus(status: string): Promise<void>;
  sendVoice(uri: string, presetStatus?: string): Promise<void>;
  snooze(minutes: number): Promise<void>;
  ack(memberId: string): Promise<void>;
  escalate(memberId: string): Promise<void>;
  resolve(memberId: string): Promise<void>;
  /** Host only: remove someone; the group key rotates so they can't read anything new. */
  remove(memberId: string): Promise<void>;
  updatePolicy(p: CheckInPolicy): Promise<void>;
  leave(): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<Huddle | null>(null);

export function useHuddle(): Huddle {
  const h = useContext(Ctx);
  if (!h) throw new Error('useHuddle outside HuddleProvider');
  return h;
}

export function HuddleProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [rawView, setView] = useState<View | null>(null);
  const [keys, setKeys] = useState<SessionKeys | null>(null);
  const view = useMemo(() => (rawView ? decryptView(rawView, keys) : null), [rawView, keys]);
  const [connection, setConnection] = useState<Connection>('offline');
  const [pendingCheckIn, setPendingCheckIn] = useState(false);
  const [modelsInstalled, setModelsInstalled] = useState(() => allInstalled());
  const [onDeviceTimings, setOnDeviceTimings] = useState<{ transcribeMs: number; extractMs: number }[]>([]);
  const onDeviceReady = profile?.onDeviceAI === true && modelsInstalled;

  const api = useMemo(() => client(profile?.serverUrl ?? '', membership?.token ?? null), [profile?.serverUrl, membership?.token]);
  const me = view?.board.rows.find((r) => r.id === view.me) ?? null;

  useEffect(() => {
    (async () => {
      await setupNotifications().catch(() => {});
      setProfile(await storage.profile());
      setMembership(await storage.membership());
      setReady(true);
    })();
  }, []);

  const forget = useCallback(async () => {
    const m = await storage.membership();
    if (m) await forgetKeys(m.sessionId);
    setKeys(null);
    await storage.clearMembership();
    await cancelPrompts();
    setMembership(null);
    setView(null);
  }, []);

  /** Run a call; a session that's gone or a revoked token drops back to the start screen. */
  const run = useCallback(
    async (fn: () => Promise<View>) => {
      try {
        const v = await fn();
        setView(v);
        return v;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404 || e.code === 'ended' || e.code === 'left')) {
          if (e.code === 'left') Alert.alert('You’re no longer in this huddle', 'You left, or the host removed you.');
          await forget();
        }
        throw e;
      }
    },
    [forget],
  );

  const refresh = useCallback(async () => {
    if (!membership) return;
    await run(() => api.view()).catch(() => {});
  }, [api, membership, run]);

  // Live updates over WebSocket, with polling as a fallback.
  useEffect(() => {
    if (!membership) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) refresh();
    }, 30_000);
    const connect = () => {
      ws = new WebSocket(api.liveUrl());
      ws.onopen = () => {
        retry = 1000;
        setConnection('live');
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'view') setView(msg.view);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = (e) => {
        if (closed) return;
        if (e.code === 4401 || e.code === 4403) return void forget();
        setConnection('polling');
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      sub.remove();
      ws?.close();
    };
  }, [api, membership, refresh, forget]);

  // Load this huddle's keys from the keychain.
  useEffect(() => {
    if (!membership) return void setKeys(null);
    loadKeys(membership.sessionId).then(setKeys);
  }, [membership?.sessionId]);

  // Key exchange: open keys wrapped for us, share ours with newcomers, claim new epochs.
  const syncing = useRef(false);
  useEffect(() => {
    if (!rawView?.keys || !keys || !membership || syncing.current) return;
    syncing.current = true;
    syncKeys(rawView, keys, api)
      .then(async (next) => {
        if (next) {
          await saveKeys(membership.sessionId, next);
          setKeys(next);
        }
      })
      .catch(() => {})
      .finally(() => (syncing.current = false));
  }, [rawView, keys, api, membership]);

  const sealNow = useCallback(() => (rawView ? sealer(rawView, keys) : null), [rawView, keys]);

  /** Where a location goes: sealed for the group; plain only for contacts, if allowed. */
  const locationPayload = useCallback(
    (fix: GeoFix | undefined): LocationPayload => {
      if (!fix) return {};
      if (!rawView?.board.e2e) return { location: fix };
      const s = sealNow();
      const escrow = profile?.contactLocation !== false && (profile?.policy.contacts.length ?? 0) > 0;
      return { ...(s ? { sealedLocation: s.location(fix) } : {}), ...(escrow ? { location: fix } : {}) };
    },
    [rawView?.board.e2e, sealNow, profile?.contactLocation, profile?.policy.contacts.length],
  );

  // Keep the on-phone "Still okay?" prompts in step with the server's schedule.
  const graceMin = profile?.policy.graceMin ?? 10;
  useEffect(() => {
    if (!me) return;
    if (me.status === 'ok' || me.status === 'due') schedulePrompts(me.nextDueAt, graceMin).catch(() => {});
    else cancelPrompts().catch(() => {});
  }, [me?.nextDueAt, me?.status, graceMin]);

  // Register for push once we're in a session.
  useEffect(() => {
    if (!membership) return;
    (async () => {
      if (!(await requestNotificationPermission())) return;
      const t = await pushToken();
      if (t) await api.pushToken(t).catch(() => {});
    })();
  }, [api, membership]);

  // A dying phone is the most common reason a friend "disappears": warn the group first.
  useEffect(() => {
    if (!membership) return;
    const sub = Battery.addBatteryLevelListener(async ({ batteryLevel: level }) => {
      if (level >= 0 && level <= 0.05) await run(async () => api.battery(level, locationPayload(await currentFix(3000)))).catch(() => {});
    });
    return () => sub.remove();
  }, [api, membership, run, locationPayload]);

  // Retry a check-in that couldn't be sent.
  useEffect(() => {
    if (!pendingCheckIn) return;
    const t = setInterval(async () => {
      try {
        await run(() => api.checkIn({}));
        setPendingCheckIn(false);
      } catch (e) {
        if (!(e instanceof OfflineError)) setPendingCheckIn(false);
      }
    }, 15_000);
    return () => clearInterval(t);
  }, [pendingCheckIn, api, run]);

  const batteryLevelNow = Battery.useBatteryLevel();
  const lowPowerMode = Battery.useLowPowerMode();
  const batterySaver = lowPowerMode || (batteryLevelNow >= 0 && batteryLevelNow < 0.2);

  const proximity = useProximity({
    enabled: Boolean(membership) && profile?.shareProximity !== false && !batterySaver,
    proximityKey: rawView ? proximityKeyFor(rawView, keys) : null,
    me: view?.me,
    memberIds: view?.board.rows.filter((r) => r.status !== 'left').map((r) => r.id) ?? [],
    api,
  });

  const liveLocation = useLiveLocation({
    enabled: Boolean(membership) && profile?.shareLiveLocation === true,
    batterySaver,
    api: membership ? api : null,
  });

  const proximityStatus = batterySaver && membership && profile?.shareProximity !== false ? 'paused-battery' : proximity;
  useFieldTest({ enabled: Boolean(membership) && profile?.fieldTest === true, api: membership ? api : null, proximity: proximityStatus, liveLocation });

  const enter = useCallback(async (r: View & { token: string }, k: SessionKeys) => {
    const m = { token: r.token, sessionId: r.board.sessionId, memberId: r.me, e2e: r.board.e2e };
    await saveKeys(m.sessionId, k);
    setKeys(k);
    await storage.saveMembership(m);
    setMembership(m);
    setView(r);
  }, []);

  /** Share a card: sealed for the group in encrypted huddles. */
  const shareCard = useCallback(
    async (card: AlertCard) => {
      const s = sealNow();
      if (!s) throw new Error("this phone doesn't have the group key yet — try a status, or wait a moment");
      await run(() => api.cardSealed(s.card(card)));
    },
    [sealNow, run, api],
  );

  const encrypted = rawView?.board.e2e === true;
  const encryptionReady = encrypted && sealNow() !== null;
  const inviteKey = encrypted && keys && rawView?.keys ? inviteKeyParam(keys, rawView.keys.epoch) : null;
  const inviteLink = rawView?.joinCode
    ? `huddle://start?code=${rawView.joinCode}${inviteKey ? `&k=${encodeURIComponent(inviteKey)}` : ''}`
    : null;

  const value: Huddle = {
    ready,
    profile,
    membership,
    view,
    me,
    connection,
    pendingCheckIn,
    proximity: proximityStatus,
    liveLocation,
    batterySaver,
    onDeviceReady,
    onDeviceTimings,
    encryptionReady,
    inviteLink,
    myPublicKey: keys?.keyPair.publicKey ?? null,
    refreshOnDevice: () => setModelsInstalled(allInstalled()),
    async saveProfile(p) {
      await storage.saveProfile(p);
      setProfile(p);
    },
    async start(name, durationHours) {
      if (!profile) throw new Error('set up your profile first');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const keyPair = newKeyPair();
      // New huddles are end-to-end encrypted; this phone claims the first group key right after.
      const r = await client(profile.serverUrl, null).create({
        name,
        memberName: profile.name,
        phone: profile.phone || undefined,
        policy: profile.policy,
        durationHours,
        timeZone: tz,
        e2e: true,
        publicKey: keyPair.publicKey,
      });
      await enter(r, { keyPair, epochs: {} });
    },
    async join(code, inviteKeyParam) {
      if (!profile) throw new Error('set up your profile first');
      const keyPair = newKeyPair();
      const invite = parseInviteKey(inviteKeyParam);
      const r = await client(profile.serverUrl, null).join({
        joinCode: code,
        memberName: profile.name,
        phone: profile.phone || undefined,
        policy: profile.policy,
        publicKey: keyPair.publicKey,
      });
      await enter(r, { keyPair, epochs: invite ? { [String(invite.epoch)]: invite.key } : {} });
    },
    async checkIn() {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const [location, battery] = await Promise.all([currentFix(3000), batteryLevel()]);
      try {
        await run(() => api.checkIn(locationPayload(location), battery));
      } catch (e) {
        if (e instanceof OfflineError) {
          setPendingCheckIn(true);
          return;
        }
        throw e;
      }
    },
    async sos(status) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      const location = await currentFix(4000);
      try {
        const s = sealNow();
        await run(() => api.sos(locationPayload(location), status && encrypted ? (s ? { sealedStatus: s.status(status) } : {}) : { status }));
        return 'sent';
      } catch (e) {
        if (!(e instanceof OfflineError)) return 'failed';
        // No data connection: fall back to the phone's own SMS, which often still works.
        const contacts = [
          ...(profile?.policy.contacts.map((c) => c.phone) ?? []),
          ...(view?.board.rows.filter((r) => r.id !== view.me && r.phone && r.status !== 'left').map((r) => r.phone!) ?? []),
        ];
        if (!contacts.length || !(await SMS.isAvailableAsync())) return 'failed';
        const where = location ? ` I'm around https://maps.google.com/?q=${location.lat.toFixed(5)},${location.lng.toFixed(5)}` : '';
        await SMS.sendSMSAsync([...new Set(contacts)], `[Huddle] ${profile?.name ?? 'I'} need${profile?.name ? 's' : ''} help.${status ? ` "${status}".` : ''}${where}`);
        return 'sms';
      }
    },
    async sendStatus(status) {
      if (!encrypted) return void (await run(() => api.status(status)));
      await shareCard(groundCard('', {}, 'preset', status).card);
    },
    async sendVoice(uri, presetStatus) {
      if (onDeviceReady) {
        try {
          const r = await processVoiceNote(uri);
          setOnDeviceTimings((t) => [...t.slice(-19), r.timings]);
          if (encrypted) await shareCard(groundCard(r.transcript, r.fields as never, `on-device:${EXTRACTOR_NAME}`, presetStatus ?? null).card);
          else await run(() => api.card({ transcript: r.transcript, fields: r.fields, extractor: EXTRACTOR_NAME, presetStatus }));
          return;
        } catch {
          /* fall through to the server's AI */
        }
      }
      const blob = await (await fetch(uri)).blob();
      const res = await api.voice(blob, 'audio/wav', presetStatus);
      // Encrypted huddles: the server returns the card without storing it; we seal it here.
      if ('card' in res) await shareCard(res.card);
      else setView(res);
    },
    async snooze(minutes) {
      await run(() => api.snooze(minutes));
    },
    async ack(id) {
      await run(() => api.ack(id));
    },
    async escalate(id) {
      await run(() => api.escalate(id));
    },
    async resolve(id) {
      await run(() => api.resolve(id));
    },
    async remove(id) {
      await run(() => api.remove(id));
    },
    async updatePolicy(p) {
      if (profile) await value.saveProfile({ ...profile, policy: p });
      if (membership) await run(() => api.policy(p));
    },
    async leave() {
      await api.leave().catch(() => {});
      await forget();
    },
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
