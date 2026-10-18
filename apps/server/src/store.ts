import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { nextWakeAt, type Millis, type Session } from '@huddle/core';

/** Unambiguous characters for join codes people read aloud in a loud room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

  /** Sessions whose next stage change is due. */
  due(now: Millis): string[] {
    return (this.db.prepare('SELECT id FROM sessions WHERE wake_at IS NOT NULL AND wake_at <= ?').all(now) as { id: string }[]).map(
      (r) => r.id,
    );
  }

  /** Delete sessions that ended long ago, with their tokens. Nothing is kept forever. */
  purge(olderThan: Millis) {
    const ids = (this.db.prepare('SELECT id FROM sessions WHERE ends_at < ?').all(olderThan) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
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
