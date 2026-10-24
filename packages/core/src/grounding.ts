import type { AlertCard, GroundedField } from './types.ts';

/**
 * The same grounding rule as services/ai/huddle_ai/card.py, so a card made on
 * the phone is checked exactly like one made on the server: a field survives
 * only if its quote appears, as whole words, in the transcript.
 */

export const CARD_FIELDS = ['stated_location', 'requested_action', 'avoid', 'condition', 'contact_preference'] as const;
export type CardField = (typeof CARD_FIELDS)[number];

const PLACEHOLDERS = new Set(['', 'null', 'none', 'n a', 'na', 'not said', 'not stated', 'unknown', 'not mentioned']);
/** Labels the model may use for contact_preference even though the speaker didn't say them. */
const CONTACT_LABELS = new Set(['phone call', 'text', 'no calls', 'no texts', 'video call']);
const STOPWORDS = new Set(
  'a an the to of at in on by for and or me my i im i\'m you your it is am are be please pls just so that this with really'.split(' '),
);

/** Crude but symmetric: come/coming/comes, place/places, call/called all meet. */
function stem(w: string): string {
  for (const suffix of ['ing', 'ed', 's']) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix) && !w.endsWith('ss')) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.length > 3 && w.endsWith('e') ? w.slice(0, -1) : w;
}

export function contentWords(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter((w) => w && !STOPWORDS.has(w)).map(stem));
}

/** The displayed value may only say what the quote says (bar the fixed contact labels). */
export function valueSupported(field: CardField, value: string, quote: string): boolean {
  if (field === 'contact_preference' && CONTACT_LABELS.has(normalize(value))) return true;
  const q = contentWords(quote);
  return [...contentWords(value)].every((w) => q.has(w));
}

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
): { card: AlertCard; dropped: CardField[]; rewritten: CardField[] } {
  const dropped: CardField[] = [];
  const rewritten: CardField[] = [];
  const pick = (name: CardField): GroundedField | null => {
    const f = raw[name];
    if (!f || typeof f !== 'object' || f.said === false) return null;
    let value = String(f.value ?? '').trim();
    const quote = String(f.quote ?? '').trim();
    if (PLACEHOLDERS.has(normalize(value)) || PLACEHOLDERS.has(normalize(quote))) return null;
    if (!isGrounded(quote, transcript) || contentWords(quote).size === 0) {
      dropped.push(name);
      return null;
    }
    // A real quote with an unsupported paraphrase: show the speaker's own words instead.
    if (!valueSupported(name, value, quote)) {
      rewritten.push(name);
      value = quote;
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
    rewritten,
  };
}
