import type { AlertCard, GroundedField } from './types.ts';

/**
 * The same grounding rule as services/ai/huddle_ai/card.py, so a card made on
 * the phone is checked exactly like one made on the server: a field survives
 * only if its quote appears, as whole words, in the transcript.
 */

export const CARD_FIELDS = ['stated_location', 'requested_action', 'avoid', 'condition', 'contact_preference'] as const;
export type CardField = (typeof CARD_FIELDS)[number];

const PLACEHOLDERS = new Set(['', 'null', 'none', 'n a', 'na', 'not said', 'not stated', 'unknown', 'not mentioned']);

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}_' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGrounded(quote: string, transcript: string): boolean {
  const q = normalize(quote);
  return q.length > 0 && ` ${normalize(transcript)} `.includes(` ${q} `);
}

type RawField = { value?: unknown; quote?: unknown; said?: unknown } | null | undefined;

/** Build an AlertCard from raw model output, dropping anything ungrounded or placeholder. */
export function groundCard(
  transcript: string,
  raw: Partial<Record<CardField, RawField>>,
  extractor: string,
  presetStatus: string | null = null,
): { card: AlertCard; dropped: CardField[] } {
  const dropped: CardField[] = [];
  const pick = (name: CardField): GroundedField | null => {
    const f = raw[name];
    if (!f || typeof f !== 'object' || f.said === false) return null;
    const value = String(f.value ?? '').trim();
    const quote = String(f.quote ?? '').trim();
    if (PLACEHOLDERS.has(normalize(value)) || PLACEHOLDERS.has(normalize(quote))) return null;
    if (!isGrounded(quote, transcript)) {
      dropped.push(name);
      return null;
    }
    return { value: value.slice(0, 200), quote: quote.slice(0, 300) };
  };
  const t = transcript.slice(0, 2000);
  return {
    card: {
      transcript: t,
      presetStatus,
      statedLocation: pick('stated_location'),
      requestedAction: pick('requested_action'),
      avoid: pick('avoid'),
      condition: pick('condition'),
      contactPreference: pick('contact_preference'),
      extractor: extractor.slice(0, 80),
    },
    dropped,
  };
}
