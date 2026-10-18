import type { Board, CheckInPolicy, GeoFix, Incident, TimelineEntry } from '@huddle/core';

export interface View {
  me: string;
  joinCode: string | null;
  board: Board;
  incidents: Incident[];
  timeline: TimelineEntry[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Network failures (no signal, server down) — distinct from the server saying no. */
export class OfflineError extends Error {}

export function client(serverUrl: string, token: string | null) {
  async function call<T>(method: string, path: string, body?: unknown, raw?: { data: Blob | ArrayBuffer; type: string }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${serverUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(raw ? 45_000 : 12_000),
      });
    } catch (e) {
      throw new OfflineError(e instanceof Error ? e.message : 'network error');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, json.error ?? 'error', json.message ?? `request failed (${res.status})`);
    return json as T;
  }

  return {
    create: (b: { name: string; memberName: string; phone?: string; policy: CheckInPolicy; durationHours: number; timeZone: string }) =>
      call<View & { token: string }>('POST', '/v1/sessions', b),
    join: (b: { joinCode: string; memberName: string; phone?: string; policy: CheckInPolicy }) =>
      call<View & { token: string }>('POST', '/v1/join', b),
    view: () => call<View>('GET', '/v1/session'),
    checkIn: (location?: GeoFix, battery?: number) => call<View>('POST', '/v1/check-in', { location, battery }),
    snooze: (minutes: number) => call<View>('POST', '/v1/snooze', { minutes }),
    sos: (location?: GeoFix, status?: string) => call<View>('POST', '/v1/sos', { location, status }),
    status: (status: string) => call<View>('POST', '/v1/status', { status }),
    voice: (data: Blob, type: string, presetStatus?: string) =>
      call<View>('POST', `/v1/voice${presetStatus ? `?preset_status=${encodeURIComponent(presetStatus)}` : ''}`, undefined, { data, type }),
    battery: (level: number, location?: GeoFix) => call<View>('POST', '/v1/battery', { level, location }),
    ack: (id: string) => call<View>('POST', `/v1/members/${id}/ack`),
    escalate: (id: string) => call<View>('POST', `/v1/members/${id}/escalate`),
    resolve: (id: string) => call<View>('POST', `/v1/members/${id}/resolve`),
    policy: (policy: CheckInPolicy) => call<View>('PUT', '/v1/policy', { policy }),
    pushToken: (t: string) => call<{ ok: true }>('PUT', '/v1/push-token', { token: t }),
    leave: () => call<View>('POST', '/v1/leave'),
    liveUrl: () => `${serverUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/live?token=${encodeURIComponent(token ?? '')}`,
  };
}

export type Client = ReturnType<typeof client>;
