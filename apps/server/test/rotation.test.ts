import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { generateKeyPair, open, planKeySync, seal } from '@huddle/core';
import { bareCard } from '../src/ai.ts';
import { buildApp } from '../src/app.ts';
import { Store } from '../src/store.ts';

const rand = (n: number) => new Uint8Array(randomBytes(n));
const T0 = Date.UTC(2026, 9, 17, 3, 0);

test('after leaving, a member learns nothing new: token, live feed and old-epoch ciphertext are all refused', async () => {
  const h = await buildApp({ store: new Store(':memory:'), sender: { push: async () => {}, sms: async () => {} }, makeCard: async () => bareCard(null), now: () => T0 });
  const http = async (method: 'GET' | 'POST', url: string, token?: string, payload?: object) => {
    const r = await h.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    return { status: r.statusCode, json: r.json() };
  };
  const policy = { intervalMin: 20, graceMin: 10, escalateAfterMin: null, contacts: [] };
  const anaKp = generateKeyPair(rand), cyKp = generateKeyPair(rand);
  const c = (await http('POST', '/v1/sessions', undefined, { name: 'G', memberName: 'Ana', e2e: true, publicKey: anaKp.publicKey, policy })).json;
  const sid = c.board.sessionId;
  const ana = { token: c.token, id: c.me, epochs: {} as Record<string, string> };
  const syncAna = async () => {
    const v = (await http('GET', '/v1/session', ana.token)).json;
    const p = planKeySync(v.keys, ana.epochs, ana.id, anaKp, rand);
    if (p.upload) await http('POST', '/v1/keys', ana.token, p.upload);
    ana.epochs = p.epochs;
  };
  await syncAna();
  const j = (await http('POST', '/v1/join', undefined, { joinCode: c.joinCode, memberName: 'Cy', publicKey: cyKp.publicKey, policy })).json;
  await syncAna();
  const cyToken = j.token;
  const cyOldKey = ana.epochs['1']!; // Cy received epoch 1 legitimately while a member

  // Cy has a live socket open before leaving; it must be closed, not keep streaming.
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (h.app.server.address() as { port: number }).port;
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live?token=${cyToken}`);
  const frames: number[] = [];
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
  ws.on('message', () => frames.push(Date.now()));
  await new Promise((r) => ws.on('open', r));

  await http('POST', '/v1/leave', cyToken);
  assert.equal(await closed, 4403, "the leaver's open live feed is closed");
  const framesAtLeave = frames.length;

  // 1. Cy's token must stop working.
  const after = await http('GET', '/v1/session', cyToken);
  assert.notEqual(after.status, 200, `left member can still read the board (status ${after.status})`);

  // 2. Ana's background task fires before her phone has the epoch-2 key: it seals with epoch 1.
  const fix = { lat: 48.8566, lng: 2.3522, at: T0 };
  const stale = seal(fix, { sessionId: sid, memberId: ana.id, field: 'location', epoch: 1, key: ana.epochs['1']! }, rand);
  const r = await http('POST', '/v1/location', ana.token, { live: true, sealedLocation: { blob: stale, at: T0 } });
  const stored = r.json.board?.rows.find((x: any) => x.id === ana.id)?.sealedLocation?.blob;
  assert.equal(r.json.error, 'stale-epoch', 'old-epoch ciphertext is refused');
  assert.equal(frames.length, framesAtLeave, 'no frames reached the leaver after leaving');
  if (stored) {
    const leaked = open(stored, { sessionId: sid, memberId: ana.id, field: 'location', keys: new Map([[1, cyOldKey]]) });
    assert.fail(`server stored a location sealed under the old epoch; the leaver can read it: ${JSON.stringify(leaked)}`);
  }
  await h.app.close();
});
