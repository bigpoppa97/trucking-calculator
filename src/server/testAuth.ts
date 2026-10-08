import type { Kysely } from 'kysely'
import type { DB, UserRole } from '../db/schema.js'
import { hashPassword } from '../auth/password.js'
import { UserRepository } from '../repositories/userRepository.js'
import { SessionRepository } from '../repositories/sessionRepository.js'

/** Seed a user with an active session; returns the cookie map for app.inject. */
export async function seedSession(
  db: Kysely<DB>,
  role: UserRole,
  email = `${role}@test.local`,
): Promise<{ cookies: { session: string }; email: string }> {
  const users = new UserRepository(db)
  const existing = await users.findByEmail(email)
  const id =
    existing?.id ??
    (
      await users.create({
        email,
        displayName: `Test ${role}`,
        role,
        passwordHash: await hashPassword('test-password-123'),
      })
    ).id
  const session = await new SessionRepository(db).create(id)
  return { cookies: { session: session.token }, email }
}
