import type { Outbound, PushMessage } from './messages.ts';

export interface Sender {
  push(tokens: string[], msg: PushMessage): Promise<void>;
  sms(to: string, body: string): Promise<void>;
}

/** Deliver rendered messages. A failed channel is logged and never blocks the others. */
export async function deliver(sender: Sender, pushTokens: Map<string, string>, out: Outbound[], log: (msg: string) => void) {
  await Promise.all(
    out.map(async (o) => {
      try {
        if (o.channel === 'push') {
          const tokens = o.memberIds.map((id) => pushTokens.get(id)).filter((t): t is string => Boolean(t));
          if (tokens.length) await sender.push(tokens, o);
        } else {
          await Promise.all(o.to.map((to) => sender.sms(to, o.body)));
        }
      } catch (e) {
        log(`delivery failed (${o.channel}): ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
}

/** Expo's push service: one HTTPS call reaches both iOS (APNs) and Android (FCM). */
export function expoPush(accessToken?: string): Sender['push'] {
  return async (tokens, msg) => {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: msg.title,
          body: msg.body,
          data: msg.data,
          sound: 'default',
          priority: msg.urgency === 'info' ? 'normal' : 'high',
          channelId: msg.urgency,
          categoryId: msg.urgency === 'checkin' ? 'checkin' : msg.urgency === 'info' ? undefined : 'alert',
          interruptionLevel: msg.urgency === 'sos' ? 'critical' : msg.urgency === 'info' ? 'active' : 'time-sensitive',
        })),
      ),
    });
    if (!res.ok) throw new Error(`expo push ${res.status}: ${await res.text()}`);
  };
}

export function twilioSms(cfg: { accountSid: string; authToken: string; from: string }): Sender['sms'] {
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  return async (to, body) => {
    const sender: Record<string, string> = cfg.from.startsWith('MG') ? { MessagingServiceSid: cfg.from } : { From: cfg.from };
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, Body: body, ...sender }),
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${await res.text()}`);
  };
}

export function senderFromEnv(env: NodeJS.ProcessEnv, log: (msg: string) => void): Sender {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, EXPO_ACCESS_TOKEN, PUSH_DISABLED } = env;
  const smsReady = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);
  if (!smsReady) log('SMS is not configured (set TWILIO_*); contact alerts will only be logged.');
  const sms = smsReady
    ? twilioSms({ accountSid: TWILIO_ACCOUNT_SID!, authToken: TWILIO_AUTH_TOKEN!, from: TWILIO_FROM! })
    : async (to: string, body: string) => log(`[sms not configured] to ${to.slice(0, -4)}****: ${body.split('\n')[0]}`);
  const push = PUSH_DISABLED
    ? async (tokens: string[], m: PushMessage) => log(`[push disabled] ${tokens.length} device(s): ${m.title}`)
    : expoPush(EXPO_ACCESS_TOKEN);
  return { push, sms };
}
