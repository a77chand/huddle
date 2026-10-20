import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { bareCard, type CardMaker } from '../src/ai.ts';
import { buildApp } from '../src/app.ts';
import type { PushMessage } from '../src/messages.ts';
import { Store } from '../src/store.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 3, 0);

async function setup(makeCard: CardMaker = async ({ presetStatus }) => bareCard(presetStatus, 'test')) {
  let clock = T0;
  const pushes: { tokens: string[]; msg: PushMessage }[] = [];
  const sms: { to: string; body: string }[] = [];
  const h = await buildApp({
    store: new Store(':memory:'),
    sender: {
      push: async (tokens, msg) => void pushes.push({ tokens, msg }),
      sms: async (to, body) => void sms.push({ to, body }),
    },
    makeCard,
    now: () => clock,
  });
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: object) => {
    const res = await h.app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
    return { status: res.statusCode, json: res.json() };
  };
  const policy = { intervalMin: 20, graceMin: 10, escalateAfterMin: 15, contacts: [{ name: 'Mom', phone: '+14155550123' }] };
  const created = await call('POST', '/v1/sessions', undefined, { name: 'Concert', memberName: 'Ana', timeZone: 'America/New_York', policy });
  const ana = created.json.token as string;
  const code = created.json.joinCode as string;
  const bea = (await call('POST', '/v1/join', undefined, { joinCode: code.toLowerCase(), memberName: 'Bea', policy })).json.token as string;
  const cyJoin = await call('POST', '/v1/join', undefined, { joinCode: code, memberName: 'Cy', policy });
  const cy = cyJoin.json.token as string;
  for (const [t, n] of [[ana, 'A'], [bea, 'B'], [cy, 'C']] as const)
    assert.equal((await call('PUT', '/v1/push-token', t, { token: `ExponentPushToken[${n}]` })).status, 200);
  return {
    ...h,
    call,
    ana,
    bea,
    cy,
    cyId: cyJoin.json.me as string,
    pushes,
    sms,
    advance: (min: number) => (clock += min * MIN),
  };
}

test('concert: Cy goes quiet → prompt → group alert → Ana responds → Cy is found', async () => {
  const t = await setup();
  t.advance(20);
  await t.call('POST', '/v1/check-in', t.ana, { location: { lat: 40.7505, lng: -73.9934 } });
  await t.call('POST', '/v1/check-in', t.bea);
  t.runDue();
  await t.idle();
  assert.equal(t.pushes.length, 0, 'prompts are local notifications on the phone');

  t.advance(10);
  t.pushes.length = 0;
  t.runDue();
  await t.idle();
  const alert = t.pushes.find((p) => p.msg.title === 'Cy missed a check-in')!;
  assert.deepEqual(alert.tokens, ['ExponentPushToken[A]', 'ExponentPushToken[B]']);
  assert.match(alert.msg.body, /Last check-in 11:00 PM\. Unreachable — not confirmed in danger/);

  const v = await t.call('GET', '/v1/session', t.bea);
  assert.equal(v.json.board.counts.needAttention, 1);
  assert.equal(v.json.incidents[0].name, 'Cy');

  const ack = await t.call('POST', `/v1/members/${t.cyId}/ack`, t.ana);
  assert.equal(ack.status, 200);
  assert.equal(ack.json.board.counts.beingHelped, 1);

  // Ana is on it, so Mom is not texted automatically.
  await t.call('POST', '/v1/check-in', t.ana);
  await t.call('POST', '/v1/check-in', t.bea);
  t.advance(20); // past Cy's escalation point (11:45)
  t.runDue();
  await t.idle();
  assert.deepEqual(t.sms, []);

  t.pushes.length = 0;
  const found = await t.call('POST', `/v1/members/${t.cyId}/resolve`, t.ana);
  assert.equal(found.json.board.counts.needAttention, 0);
  await t.idle();
  assert.ok(t.pushes.some((p) => p.msg.body === 'Ana marked Cy as safe.'));
});

test('nobody responds → contacts get the incident text, then the all-clear', async () => {
  const t = await setup();
  await t.call('POST', '/v1/check-in', t.cy, { location: { lat: 40.7505, lng: -73.9934, accuracyM: 20 } });
  t.advance(60);
  t.runDue();
  await t.idle();
  const cyText = t.sms.find((s) => s.body.includes('Cy missed a check-in'))!;
  assert.equal(cyText.to, '+14155550123');
  assert.match(cyText.body, /Last check-in: 11:00 PM/);
  assert.match(cyText.body, /maps\.google\.com/);
  assert.match(cyText.body, /Not known:/);

  t.sms.length = 0;
  await t.call('POST', '/v1/check-in', t.cy);
  await t.idle();
  assert.match(t.sms[0]!.body, /All clear: Cy checked in and is okay/);
});

test('SOS goes out before the voice note is processed; the card follows', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t = await setup(async () => {
    await gate;
    return {
      ...bareCard(null, 'fake-llm'),
      transcript: "I'm by the north entrance, please call me, don't come inside",
      requestedAction: { value: 'call me', quote: 'please call me' },
      avoid: { value: 'come inside', quote: "don't come inside" },
    };
  });
  const s = await t.call('POST', '/v1/sos', t.bea, { status: 'Need help', location: { lat: 40.75, lng: -73.99 } });
  assert.equal(s.json.board.rows.find((r: any) => r.name === 'Bea').status, 'sos');
  await t.idle();
  assert.ok(t.pushes.some((p) => p.msg.title === '🚨 Bea asked for help' && p.msg.urgency === 'sos'));
  assert.ok(t.sms.some((x) => x.body.includes('Bea asked for help')));

  const voice = t.app.inject({
    method: 'POST',
    url: '/v1/voice',
    headers: { authorization: `Bearer ${t.bea}`, 'content-type': 'audio/m4a' },
    payload: Buffer.from('fake-audio'),
  });
  release();
  const v = (await voice).json();
  const inc = v.incidents.find((i: any) => i.name === 'Bea');
  assert.ok(inc.nextSteps.includes('Respect: do not come inside.'));
  await t.idle();
  assert.ok(t.pushes.some((p) => p.msg.title === 'Bea sent details' && p.msg.body.includes("don't come inside")));
});

test('AI failure still records the preset status', async () => {
  const t = await setup(async () => {
    throw new Error('model down');
  });
  await t.call('POST', '/v1/sos', t.bea);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/voice?preset_status=Come%20find%20me',
    headers: { authorization: `Bearer ${t.bea}`, 'content-type': 'audio/m4a' },
    payload: Buffer.from('x'),
  });
  const row = res.json().board.rows.find((r: any) => r.name === 'Bea');
  assert.equal(row.card.extractor, 'ai-unavailable');
  assert.equal(row.card.presetStatus, 'Come find me');
});

test('proximity: members get the key; sightings show up in the overdue alert', async () => {
  const t = await setup();
  const ana = await t.call('GET', '/v1/session', t.ana);
  assert.match(ana.json.proximityKey, /^[0-9a-f]{32}$/);
  t.advance(25);
  await t.call('POST', '/v1/check-in', t.ana);
  await t.call('POST', '/v1/check-in', t.bea);
  const r = await t.call('POST', '/v1/proximity', t.ana, { sightings: [{ memberId: t.cyId, at: T0 + 24 * MIN }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.board.rows.find((x: any) => x.name === 'Cy').lastNear.name, 'Ana');
  t.advance(6);
  t.runDue();
  await t.idle();
  const alert = t.pushes.find((p) => p.msg.title === 'Cy missed a check-in')!;
  assert.match(alert.msg.body, /Last near Ana's phone 11:24 PM\./);
  assert.equal((await t.call('POST', '/v1/proximity', t.ana, { sightings: 'x' })).status, 400);
});

test('live location endpoint', async () => {
  const t = await setup();
  const on = await t.call('POST', '/v1/location', t.cy, { live: true, location: { lat: 40.75, lng: -73.99 } });
  const cy = on.json.board.rows.find((r: any) => r.name === 'Cy');
  assert.equal(cy.liveLocation, true);
  assert.equal(cy.lastLocation.lat, 40.75);
  const off = await t.call('POST', '/v1/location', t.cy, { live: false });
  assert.equal(off.json.board.rows.find((r: any) => r.name === 'Cy').liveLocation, false);
  assert.equal((await t.call('POST', '/v1/location', t.cy, { location: { lat: 1, lng: 1 } })).status, 400);
});

test('on-device card is re-grounded by the server', async () => {
  const t = await setup();
  await t.call('POST', '/v1/sos', t.bea);
  const r = await t.call('POST', '/v1/card', t.bea, {
    transcript: "I'm by the coat check, don't come inside",
    extractor: 'huddle-extractor-0.5b',
    fields: {
      stated_location: { said: true, value: 'coat check', quote: 'by the coat check' },
      avoid: { said: true, value: 'come inside', quote: "don't come inside" },
      requested_action: { said: true, value: 'call the police', quote: 'call the police' }, // not said: dropped
    },
  });
  const card = r.json.board.rows.find((x: any) => x.name === 'Bea').card;
  assert.equal(card.extractor, 'on-device:huddle-extractor-0.5b');
  assert.equal(card.statedLocation.value, 'coat check');
  assert.equal(card.avoid.value, 'come inside');
  assert.equal(card.requestedAction, null);
});

test('field-test report: delivery latency, battery drain, check-in responses', async () => {
  const t = await setup();
  // Cy misses a check-in; Ana answers hers quickly.
  t.advance(20);
  t.runDue();
  t.advance(1);
  await t.call('POST', '/v1/check-in', t.ana);
  await t.call('POST', '/v1/check-in', t.bea);
  t.advance(9);
  t.runDue();
  await t.idle();
  // Two hours of Ana's phone: 80% -> 70%, with a charging stretch that must be ignored.
  const base = T0 + 30 * MIN;
  const samples = [0, 30, 60, 90, 120].map((m, i) => ({
    at: base + m * MIN - 120 * MIN,
    battery: [0.8, 0.775, 0.75, 0.725, 0.7][i],
    charging: false,
    proximity: 'poweredOn',
    liveLocation: 'off',
    sightings: 3,
  }));
  samples.push({ at: base, battery: 0.9, charging: true, proximity: 'poweredOn', liveLocation: 'off', sightings: 0 });
  assert.equal((await t.call('POST', '/v1/diagnostics', t.ana, { samples })).json.stored, 6);

  const r = (await t.call('GET', '/v1/report', t.ana)).json;
  const alert = r.alerts.find((a: any) => a.channel === 'push' && a.kind === 'group-alert');
  assert.equal(alert.count, 1);
  assert.equal(alert.okRate, 1);
  assert.equal(alert.medianMs, 0, 'fake clock: no scheduler lag');
  const ana = r.battery.find((b: any) => b.member === 'Ana');
  assert.equal(ana.drainPerHour, 5, '10 points over 2 hours, charging excluded');
  assert.equal(ana.bluetooth, 'poweredOn');
  assert.equal(r.bluetooth.find((b: any) => b.member === 'Ana').sightings, 15);
  const anaCheck = r.checkIns.find((c: any) => c.member === 'Ana');
  assert.equal(anaCheck.prompts, 1);
  assert.equal(anaCheck.medianResponseS, 60);
  assert.equal(r.checkIns.find((c: any) => c.member === 'Cy').overdue, 1);
  const md = await t.app.inject({ method: 'GET', url: '/v1/report?format=md', headers: { authorization: `Bearer ${t.ana}` } });
  assert.match(md.body, /### Battery \(excluding time on charge\)/);
  assert.match(md.body, /\| Ana \| 2 h \| 5% \|/);
});

test('auth, validation and join-code errors', async () => {
  const t = await setup();
  assert.equal((await t.call('GET', '/v1/session')).status, 401);
  assert.equal((await t.call('GET', '/v1/session', 'nope')).status, 401);
  assert.equal((await t.call('POST', '/v1/join', undefined, { joinCode: 'ZZZZZZ', memberName: 'X' })).status, 404);
  assert.equal((await t.call('POST', '/v1/snooze', t.ana, { minutes: 1 })).json.error, 'bad-snooze');
  assert.equal((await t.call('POST', '/v1/check-in', t.ana, { location: { lat: 200, lng: 0 } })).status, 400);
  assert.equal((await t.call('POST', `/v1/members/${t.cyId}/ack`, t.ana)).json.error, 'not-needed');
  assert.equal((await t.call('PUT', '/v1/push-token', t.ana, { token: 'abc' })).status, 400);
});

test('live socket receives the board on connect and after changes', async () => {
  const t = await setup();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live?token=${t.ana}`);
  const views: any[] = [];
  const got = (n: number) =>
    new Promise<void>((resolve) => {
      const check = () => (views.length >= n ? resolve() : setTimeout(check, 5));
      check();
    });
  ws.on('message', (d) => views.push(JSON.parse(String(d))));
  await got(1);
  assert.equal(views[0].view.board.counts.present, 3);
  await t.call('POST', '/v1/sos', t.cy);
  await got(2);
  assert.equal(views[1].view.board.counts.needAttention, 1);
  ws.close();
  await t.app.close();
});
