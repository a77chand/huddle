/**
 * Field-test report: turns a real night out into numbers.
 *
 *   node apps/server/src/report.ts --db huddle.db            # every session
 *   node apps/server/src/report.ts --db huddle.db --session <id>
 *
 * Also served to members at GET /v1/report.
 */
import type { Session } from '@huddle/core';
import type { Store } from './store.ts';

type Delivery = ReturnType<Store['deliveries']>[number];
type Sample = ReturnType<Store['diagnostics']>[number];

export interface Report {
  session: { id: string; name: string; members: number; hours: number };
  alerts: { channel: string; kind: string; count: number; okRate: number; medianMs: number; p95Ms: number; maxMs: number }[];
  battery: {
    member: string;
    hours: number;
    drainPerHour: number | null;
    start: number | null;
    end: number | null;
    bluetooth: string;
    liveLocation: string;
    samples: number;
  }[];
  bluetooth: { member: string; sightings: number; friendsSeen: number; radioOnShare: number | null }[];
  checkIns: { member: string; prompts: number; answeredWithinGrace: number; medianResponseS: number | null; overdue: number; sos: number }[];
}

const HOUR = 3600_000;

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

function mode(xs: (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
}

/** Battery drain over stretches where the phone wasn't charging, weighted by time. */
function drain(samples: Sample[]): { hours: number; perHour: number | null } {
  let used = 0;
  let ms = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (a.charging || b.charging || a.battery === null || b.battery === null) continue;
    const dt = b.at - a.at;
    if (dt <= 0 || dt > 2 * HOUR) continue; // gaps mean the app wasn't sampling
    used += Math.max(0, a.battery - b.battery);
    ms += dt;
  }
  return { hours: ms / HOUR, perHour: ms >= 0.5 * HOUR ? (used * 100) / (ms / HOUR) : null };
}

export function buildReport(session: Session, deliveries: Delivery[], diagnostics: Sample[]): Report {
  const name = (id: string) => session.members.find((m) => m.id === id)?.name ?? id.slice(0, 6);
  const end = session.endedAt ?? Math.min(Date.now(), session.endsAt);

  const groups = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    const key = `${d.channel}|${d.kind.split(':')[0]}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const alerts = [...groups].map(([key, ds]) => {
    const [channel, kind] = key.split('|') as [string, string];
    const lat = ds.map((d) => d.sent_at - d.due_at);
    return {
      channel,
      kind,
      count: ds.length,
      okRate: ds.filter((d) => d.ok).length / ds.length,
      medianMs: quantile(lat, 0.5),
      p95Ms: quantile(lat, 0.95),
      maxMs: Math.max(...lat),
    };
  });

  const byMember = new Map<string, Sample[]>();
  for (const s of diagnostics) byMember.set(s.member_id, [...(byMember.get(s.member_id) ?? []), s]);

  const battery = [...byMember].map(([id, ss]) => {
    const d = drain(ss);
    return {
      member: name(id),
      hours: Math.round(d.hours * 10) / 10,
      drainPerHour: d.perHour === null ? null : Math.round(d.perHour * 10) / 10,
      start: ss[0]?.battery ?? null,
      end: ss[ss.length - 1]?.battery ?? null,
      bluetooth: mode(ss.map((s) => s.proximity)),
      liveLocation: mode(ss.map((s) => s.live_location)),
      samples: ss.length,
    };
  });

  const bluetooth = session.members.map((m) => {
    const ss = byMember.get(m.id) ?? [];
    return {
      member: m.name,
      sightings: ss.reduce((n, s) => n + (s.sightings ?? 0), 0),
      friendsSeen: Object.keys(m.seenNear ?? {}).length,
      radioOnShare: ss.length ? ss.filter((s) => s.proximity === 'poweredOn').length / ss.length : null,
    };
  });

  const checkIns = session.members.map((m) => {
    const events = session.timeline.filter((e) => e.memberId === m.id);
    const responses: number[] = [];
    let prompts = 0;
    let answered = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.kind !== 'prompt') continue;
      prompts++;
      const next = events.slice(i + 1).find((e) => e.kind === 'check-in' || e.kind === 'resolved' || e.kind === 'prompt');
      if (next && next.kind !== 'prompt') {
        const s = (next.at - events[i]!.at) / 1000;
        responses.push(s);
        if (s <= m.policy.graceMin * 60) answered++;
      }
    }
    return {
      member: m.name,
      prompts,
      answeredWithinGrace: answered,
      medianResponseS: responses.length ? Math.round(quantile(responses, 0.5)) : null,
      overdue: events.filter((e) => e.kind === 'overdue').length,
      sos: events.filter((e) => e.kind === 'sos').length,
    };
  });

  return {
    session: { id: session.id, name: session.name, members: session.members.length, hours: Math.round(((end - session.createdAt) / HOUR) * 10) / 10 },
    alerts,
    battery,
    bluetooth,
    checkIns,
  };
}

export function toMarkdown(r: Report): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    `## ${r.session.name} — ${r.session.members} people, ${r.session.hours} h`,
    '',
    '### Alert delivery (due → sent)',
    '| Channel | Kind | Count | Delivered | Median | p95 | Max |',
    '|---|---|---|---|---|---|---|',
    ...r.alerts.map((a) => `| ${a.channel} | ${a.kind} | ${a.count} | ${pct(a.okRate)} | ${s(a.medianMs)} | ${s(a.p95Ms)} | ${s(a.maxMs)} |`),
    '',
    '### Battery (excluding time on charge)',
    '| Person | Measured | Drain / hour | Start → end | Bluetooth | Live location |',
    '|---|---|---|---|---|---|',
    ...r.battery.map(
      (b) =>
        `| ${b.member} | ${b.hours} h | ${b.drainPerHour === null ? '—' : `${b.drainPerHour}%`} | ${pct(b.start)} → ${pct(b.end)} | ${b.bluetooth} | ${b.liveLocation} |`,
    ),
    '',
    '### Bluetooth "last seen near"',
    '| Person | Sightings | Friends seen | Radio on |',
    '|---|---|---|---|',
    ...r.bluetooth.map((b) => `| ${b.member} | ${b.sightings} | ${b.friendsSeen} | ${pct(b.radioOnShare)} |`),
    '',
    '### Check-ins',
    '| Person | Prompts | Answered in grace | Median response | Overdue | SOS |',
    '|---|---|---|---|---|---|',
    ...r.checkIns.map(
      (c) => `| ${c.member} | ${c.prompts} | ${c.answeredWithinGrace} | ${c.medianResponseS === null ? '—' : `${c.medianResponseS} s`} | ${c.overdue} | ${c.sos} |`,
    ),
  ];
  return lines.join('\n');
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Store } = await import('./store.ts');
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const store = new Store(arg('--db') ?? 'huddle.db');
  const ids = arg('--session') ? [arg('--session')!] : store.allSessionIds();
  for (const id of ids) {
    const s = store.get(id);
    if (s) console.log(toMarkdown(buildReport(s, store.deliveries(id), store.diagnostics(id))) + '\n');
  }
}

