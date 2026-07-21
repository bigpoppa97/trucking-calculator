import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB, UserRole } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { UserRepository, type User } from '../repositories/userRepository.js'
import { SessionRepository, SESSION_TTL_MS } from '../repositories/sessionRepository.js'

/**
 * Session-cookie auth (PRD §5.1: email+password, roles dispatcher/finance/
 * admin, no self-registration — admin creates accounts).
 *
 * Every /api/* route except login requires a valid session; the resolved
 * user is attached to request.user and carries the identity written into
 * all audit fields.
 */

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null
  }
}

export const SESSION_COOKIE = 'session'

const CREDENTIALS_MESSAGE = 'Invalid email or password.'
const UNAUTHENTICATED = { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }
const FORBIDDEN = { error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } }

export interface AuthDeps {
  users: UserRepository
  sessions: SessionRepository
}

export function buildAuthDeps(db: Kysely<DB>): AuthDeps {
  return { users: new UserRepository(db), sessions: new SessionRepository(db) }
}

/** Routes that must work without a session. */
const PUBLIC_PATHS = new Set(['/api/auth/login'])

export function registerAuthHook(app: FastifyInstance, deps: AuthDeps): void {
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? request.url
    if (PUBLIC_PATHS.has(path)) return
    const token = request.cookies[SESSION_COOKIE]
    if (!token) return reply.status(401).send(UNAUTHENTICATED)
    const userRow = await deps.sessions.resolveUser(token)
    if (!userRow) return reply.status(401).send(UNAUTHENTICATED)
    request.user = UserRepository.toPublic(userRow)
  })
}

/** preHandler guard: only the given roles may proceed. */
export function requireRole(...roles: UserRole[]): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.user || !roles.includes(request.user.role)) {
      return reply.status(403).send(FORBIDDEN)
    }
  }
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
          required: ['email', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userRow = await deps.users.findByEmail(request.body.email)
      if (!userRow || userRow.active !== 1) {
        return reply.status(401).send({ error: { code: 'INVALID_CREDENTIALS', message: CREDENTIALS_MESSAGE } })
      }
      const ok = await verifyPassword(request.body.password, userRow.password_hash)
      if (!ok) {
        return reply.status(401).send({ error: { code: 'INVALID_CREDENTIALS', message: CREDENTIALS_MESSAGE } })
      }
      const session = await deps.sessions.create(userRow.id)
      reply.setCookie(SESSION_COOKIE, session.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
      return reply.send({ user: UserRepository.toPublic(userRow) })
    },
  )

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) await deps.sessions.delete(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/auth/me', async (request, reply) => {
    return reply.send({ user: request.user })
  })

  // Admin-only user management (no self-registration).
  app.get('/api/users', { preHandler: requireRole('admin') }, async (_request, reply) => {
    return reply.send({ users: await deps.users.listAll() })
  })

  app.post<{ Body: { email: string; displayName: string; role: UserRole; password: string } }>(
    '/api/users',
    {
      preHandler: requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^\\S+@\\S+\\.\\S+$' },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
            role: { type: 'string', enum: ['dispatcher', 'finance', 'admin'] },
            password: { type: 'string', minLength: 8, maxLength: 200 },
          },
          required: ['email', 'displayName', 'role', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (await deps.users.findByEmail(request.body.email)) {
        return reply
          .status(409)
          .send({ error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists.' } })
      }
      const user = await deps.users.create({
        email: request.body.email,
        displayName: request.body.displayName,
        role: request.body.role,
        passwordHash: await hashPassword(request.body.password),
      })
      return reply.status(201).send({ user })
    },
  )

  app.patch<{ Params: { id: string }; Body: { role?: UserRole; active?: boolean; password?: string; displayName?: string } }>(
    '/api/users/:id',
    {
      preHandler: requireRole('admin'),
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^\\d+$' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['dispatcher', 'finance', 'admin'] },
            active: { type: 'boolean' },
            password: { type: 'string', minLength: 8, maxLength: 200 },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id)
      const target = await deps.users.findById(id)
      if (!target) {
        return reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } })
      }
      // Never allow locking everyone out: the last active admin cannot be
      // deactivated or demoted.
      const losesAdmin =
        target.role === 'admin' &&
        target.active === 1 &&
        (request.body.active === false || (request.body.role !== undefined && request.body.role !== 'admin'))
      if (losesAdmin && (await deps.users.countAdmins()) <= 1) {
        return reply
          .status(400)
          .send({ error: { code: 'LAST_ADMIN', message: 'Cannot deactivate or demote the last admin account.' } })
      }
      const patch: { role?: UserRole; active?: boolean; passwordHash?: string; displayName?: string } = {}
      if (request.body.role !== undefined) patch.role = request.body.role
      if (request.body.active !== undefined) patch.active = request.body.active
      if (request.body.displayName !== undefined) patch.displayName = request.body.displayName
      if (request.body.password !== undefined) patch.passwordHash = await hashPassword(request.body.password)
      const user = await deps.users.updateById(id, patch)
      // Deactivation and password changes invalidate existing sessions.
      if (request.body.active === false || request.body.password !== undefined) {
        await deps.sessions.deleteAllForUser(id)
      }
      return reply.send({ user })
    },
  )
}
