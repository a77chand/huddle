import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundCard, isGrounded } from '../src/grounding.ts';

// Mirrors services/ai/tests/test_ai.py so phone and server agree.
test('grounding needs whole words and tolerates case, punctuation and curly quotes', () => {
  assert.ok(isGrounded('call me', 'please CALL me!'));
  assert.ok(isGrounded('don’t come', "don't come in"));
  assert.ok(isGrounded('entrada sur', 'Estoy en la entrada sur, no me siento bien.'));
  assert.ok(!isGrounded('all me', 'please call me'));
  assert.ok(!isGrounded('', 'anything'));
});

test('groundCard drops invented quotes, placeholders and said=false fields', () => {
  const { card, dropped } = groundCard(
    "I'm near the north entrance, please call me",
    {
      stated_location: { said: true, value: 'north entrance', quote: 'near the North Entrance' },
      requested_action: { said: true, value: 'come inside', quote: 'come inside now' },
      avoid: { said: false, value: '', quote: '' },
      condition: { value: 'null', quote: 'null' },
      contact_preference: { said: true, value: 'phone call', quote: 'please call me' },
    },
    'on-device:test',
    'Call me',
  );
  assert.deepEqual(card.statedLocation, { value: 'north entrance', quote: 'near the North Entrance' });
  assert.equal(card.requestedAction, null);
  assert.equal(card.avoid, null);
  assert.equal(card.condition, null);
  assert.deepEqual(card.contactPreference, { value: 'phone call', quote: 'please call me' });
  assert.equal(card.presetStatus, 'Call me');
  assert.deepEqual(dropped, ['requested_action']);
});

test('grounding matches the shared cases (same file the Python service is tested with)', async () => {
  const { readFileSync } = await import('node:fs');
  const cases = JSON.parse(readFileSync(new URL('../../../fixtures/grounding-cases.json', import.meta.url), 'utf8')) as {
    why: string; transcript: string; field: 'stated_location' | 'requested_action' | 'avoid' | 'condition' | 'contact_preference';
    value: string; quote: string; expect: string;
  }[];
  const key = { stated_location: 'statedLocation', requested_action: 'requestedAction', avoid: 'avoid', condition: 'condition', contact_preference: 'contactPreference' } as const;
  for (const c of cases) {
    const { card, dropped, rewritten } = groundCard(c.transcript, { [c.field]: { value: c.value, quote: c.quote } }, 'case');
    const got = card[key[c.field]];
    const outcome = dropped.includes(c.field) ? 'dropped' : rewritten.includes(c.field) ? 'rewritten' : got ? 'kept' : 'absent';
    assert.equal(outcome, c.expect, c.why);
    if (outcome === 'rewritten') assert.equal(got!.value, c.quote, "an unsupported value is replaced by the speaker's words");
  }
});
