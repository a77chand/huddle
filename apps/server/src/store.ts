import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { nextWakeAt, type Millis, type Session } from '@huddle/core';

/** Unambiguous characters for join codes people read aloud in a loud room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface Diagnostic {
  at: Millis;
  battery: number | null;
  lowPower: boolean;
  charging: boolean;
  proximity: string | null;
  liveLocation: string | null;
  appState: string | null;
  /** Bluetooth sightings recorded since the previous sample. */
  sightings: number | null;
}

export interface Auth {
  sessionId: string;
  memberId: string;
}

/**
 * Sessions are stored as whole JSON documents: they are small (≤ 20 people,
 * capped timeline) and always loaded and saved as a unit by the engine.
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        join_code TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        wake_at INTEGER,
        ends_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_wake ON sessions(wake_at);
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL
      );
      -- Field-test measurements: every notification attempt, with timing.
      CREATE TABLE IF NOT EXISTS deliveries (
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        recipients INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        ok INTEGER NOT NULL
      );
      -- Opt-in phone diagnostics (battery, radios), sampled every few minutes.
      CREATE TABLE IF NOT EXISTS diagnostics (
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        battery REAL,
        low_power INTEGER,
        charging INTEGER,
        proximity TEXT,
        live_location TEXT,
        app_state TEXT,
        sightings INTEGER
      );
      -- E2E: the group key for each epoch, sealed to each member's public key.
      -- The server stores these but can't open them.
      CREATE TABLE IF NOT EXISTS key_wraps (
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        blob TEXT NOT NULL,
        by_member TEXT NOT NULL,
        PRIMARY KEY (session_id, member_id, epoch)
      );
      -- Unguessable links that let a member's emergency contacts follow the incident.
      CREATE TABLE IF NOT EXISTS contact_links (
        token TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        UNIQUE (session_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        token TEXT NOT NULL,
        PRIMARY KEY (session_id, member_id)
      );
    `);
  }

  insert(session: Session): string {
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      try {
        this.db
          .prepare('INSERT INTO sessions (id, join_code, data, wake_at, ends_at) VALUES (?, ?, ?, ?, ?)')
          .run(session.id, code, JSON.stringify(session), nextWakeAt(session), session.endsAt);
        return code;
      } catch (e) {
        if (!String(e).includes('UNIQUE')) throw e;
      }
    }
  }

  save(session: Session) {
    this.db
      .prepare('UPDATE sessions SET data = ?, wake_at = ? WHERE id = ?')
      .run(JSON.stringify(session), nextWakeAt(session), session.id);
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  byJoinCode(code: string): Session | null {
    const row = this.db
      .prepare('SELECT data FROM sessions WHERE join_code = ?')
      .get(code.toUpperCase().replace(/[^A-Z0-9]/g, '')) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  joinCode(id: string): string | null {
    const row = this.db.prepare('SELECT join_code FROM sessions WHERE id = ?').get(id) as { join_code: string } | undefined;
    return row?.join_code ?? null;
  }

  /** Insert all wraps or none (a wrap that already exists means another phone got there first). */
  putWraps(sessionId: string, by: string, epoch: number, wraps: { memberId: string; blob: string }[]): boolean {
    const exists = this.db.prepare('SELECT 1 FROM key_wraps WHERE session_id = ? AND member_id = ? AND epoch = ?');
    const insert = this.db.prepare('INSERT INTO key_wraps VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (wraps.some((w) => exists.get(sessionId, w.memberId, epoch))) {
        this.db.exec('ROLLBACK');
        return false;
      }
      for (const w of wraps) insert.run(sessionId, w.memberId, epoch, w.blob, by);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  wrapsFor(sessionId: string, memberId: string): { epoch: number; blob: string }[] {
    return this.db.prepare('SELECT epoch, blob FROM key_wraps WHERE session_id = ? AND member_id = ? ORDER BY epoch').all(sessionId, memberId) as {
      epoch: number;
      blob: string;
    }[];
  }

  wrappedMembers(sessionId: string, epoch: number): Set<string> {
    const rows = this.db.prepare('SELECT member_id FROM key_wraps WHERE session_id = ? AND epoch = ?').all(sessionId, epoch) as { member_id: string }[];
    return new Set(rows.map((r) => r.member_id));
  }

  /** The contacts' link token for a member, created on first use. */
  contactLink(sessionId: string, memberId: string): string {
    const row = this.db.prepare('SELECT token FROM contact_links WHERE session_id = ? AND member_id = ?').get(sessionId, memberId) as
      | { token: string }
      | undefined;
    if (row) return row.token;
    const token = randomBytes(18).toString('base64url');
    this.db.prepare('INSERT INTO contact_links VALUES (?, ?, ?)').run(token, sessionId, memberId);
    return token;
  }

  byContactLink(token: string): { sessionId: string; memberId: string } | null {
    const row = this.db.prepare('SELECT session_id, member_id FROM contact_links WHERE token = ?').get(token) as
      | { session_id: string; member_id: string }
      | undefined;
    return row ? { sessionId: row.session_id, memberId: row.member_id } : null;
  }

  allSessionIds(): string[] {
    return (this.db.prepare('SELECT id FROM sessions ORDER BY ends_at').all() as { id: string }[]).map((r) => r.id);
  }

  /** Sessions whose next stage change is due. */
  due(now: Millis): string[] {
    return (this.db.prepare('SELECT id FROM sessions WHERE wake_at IS NOT NULL AND wake_at <= ?').all(now) as { id: string }[]).map(
      (r) => r.id,
    );
  }

  logDelivery(d: { sessionId: string; memberId: string; kind: string; channel: string; recipients: number; dueAt: Millis; sentAt: Millis; ok: boolean }) {
    this.db
      .prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.sessionId, d.memberId, d.kind, d.channel, d.recipients, d.dueAt, d.sentAt, d.ok ? 1 : 0);
  }

  addDiagnostics(auth: Auth, samples: Diagnostic[]) {
    const stmt = this.db.prepare('INSERT INTO diagnostics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of samples)
      stmt.run(auth.sessionId, auth.memberId, s.at, s.battery, s.lowPower ? 1 : 0, s.charging ? 1 : 0, s.proximity, s.liveLocation, s.appState, s.sightings);
  }

  deliveries(sessionId: string) {
    return this.db.prepare('SELECT * FROM deliveries WHERE session_id = ? ORDER BY sent_at').all(sessionId) as {
      member_id: string;
      kind: string;
      channel: string;
      recipients: number;
      due_at: number;
      sent_at: number;
      ok: number;
    }[];
  }

  diagnostics(sessionId: string) {
    return this.db.prepare('SELECT * FROM diagnostics WHERE session_id = ? ORDER BY member_id, at').all(sessionId) as {
      member_id: string;
      at: number;
      battery: number | null;
      low_power: number;
      charging: number;
      proximity: string | null;
      live_location: string | null;
      app_state: string | null;
      sightings: number | null;
    }[];
  }

  /** Delete sessions that ended long ago, with their tokens. Nothing is kept forever. */
  purge(olderThan: Millis) {
    const ids = (this.db.prepare('SELECT id FROM sessions WHERE ends_at < ?').all(olderThan) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare('DELETE FROM deliveries WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM key_wraps WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM contact_links WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM diagnostics WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM tokens WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM push_tokens WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
    return ids.length;
  }

  /** Issue a bearer token; only its hash is stored. */
  issueToken(auth: Auth): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO tokens (hash, session_id, member_id) VALUES (?, ?, ?)').run(hash(token), auth.sessionId, auth.memberId);
    return token;
  }

  auth(token: string): Auth | null {
    const row = this.db.prepare('SELECT session_id, member_id FROM tokens WHERE hash = ?').get(hash(token)) as
      | { session_id: string; member_id: string }
      | undefined;
    return row ? { sessionId: row.session_id, memberId: row.member_id } : null;
  }

  setPushToken(auth: Auth, token: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO push_tokens (session_id, member_id, token) VALUES (?, ?, ?)')
      .run(auth.sessionId, auth.memberId, token);
  }

  pushTokens(sessionId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT member_id, token FROM push_tokens WHERE session_id = ?').all(sessionId) as {
      member_id: string;
      token: string;
    }[];
    return new Map(rows.map((r) => [r.member_id, r.token]));
  }
}

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
