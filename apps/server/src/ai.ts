import type { AlertCard } from '@huddle/core';

export interface VoiceInput {
  audio: Buffer | null;
  contentType: string | null;
  presetStatus: string | null;
}

export type CardMaker = (input: VoiceInput) => Promise<AlertCard>;

/** A card with only what we know for sure — used when the AI service is off or fails. */
export function bareCard(presetStatus: string | null, note = 'none'): AlertCard {
  return {
    transcript: '',
    presetStatus,
    statedLocation: null,
    requestedAction: null,
    avoid: null,
    condition: null,
    contactPreference: null,
    extractor: note,
  };
}

/**
 * Calls the open-weight AI service (services/ai). It is never on the alert
 * path: the SOS has already gone out before this runs.
 */
export function aiService(baseUrl: string | undefined, timeoutMs = 25_000): CardMaker {
  return async ({ audio, contentType, presetStatus }) => {
    if (!baseUrl || !audio) return bareCard(presetStatus, baseUrl ? 'none' : 'ai-disabled');
    const url = new URL('/v1/voice-card', baseUrl);
    if (presetStatus) url.searchParams.set('preset_status', presetStatus);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType ?? 'application/octet-stream' },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ai service ${res.status}`);
    const c = (await res.json()) as Record<string, unknown>;
    const field = (v: unknown) =>
      v && typeof v === 'object' && typeof (v as any).value === 'string' && typeof (v as any).quote === 'string'
        ? { value: String((v as any).value).slice(0, 200), quote: String((v as any).quote).slice(0, 300) }
        : null;
    return {
      transcript: String(c.transcript ?? '').slice(0, 2000),
      presetStatus,
      statedLocation: field(c.stated_location),
      requestedAction: field(c.requested_action),
      avoid: field(c.avoid),
      condition: field(c.condition),
      contactPreference: field(c.contact_preference),
      extractor: String(c.extractor ?? 'unknown').slice(0, 80),
    };
  };
}
