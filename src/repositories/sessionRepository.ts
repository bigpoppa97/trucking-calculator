import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DB, UserRow } from '../db/schema.js'

export const SESSION_TTL_MS = 1000 * 60 * 60 * 12 // 12 hours

export class SessionRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async create(userId: number, now: Date = new Date()): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    await this.db
      .insertInto('sessions')
      .values({ token, user_id: userId, created_at: now.toISOString(), expires_at: expiresAt })
      .execute()
    return { token, expiresAt }
  }

  /** Resolve a session token to its active user; expired or unknown → undefined. */
  async resolveUser(token: string, now: Date = new Date()): Promise<UserRow | undefined> {
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .selectAll('users')
      .select('sessions.expires_at as session_expires_at')
      .where('sessions.token', '=', token)
      .executeTakeFirst()
    if (!row) return undefined
    if (row.session_expires_at <= now.toISOString()) {
      await this.delete(token)
      return undefined
    }
    if (row.active !== 1) return undefined
    const { session_expires_at: _expires, ...user } = row
    return user
  }

  async delete(token: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('token', '=', token).execute()
  }

  async deleteAllForUser(userId: number): Promise<void> {
    await this.db.deleteFrom('sessions').where('user_id', '=', userId).execute()
  }

  async deleteExpired(now: Date = new Date()): Promise<void> {
    await this.db.deleteFrom('sessions').where('expires_at', '<=', now.toISOString()).execute()
  }
}
