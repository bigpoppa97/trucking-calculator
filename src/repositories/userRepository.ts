import type { Kysely } from 'kysely'
import type { DB, UserRole, UserRow } from '../db/schema.js'

export interface User {
  id: number
  email: string
  displayName: string
  role: UserRole
  active: boolean
  createdAt: string
}

export interface NewUserInput {
  email: string
  displayName: string
  passwordHash: string
  role: UserRole
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
    createdAt: row.created_at,
  }
}

export class UserRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst()
  }

  async findById(id: number): Promise<UserRow | undefined> {
    return this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async listAll(): Promise<User[]> {
    const rows = await this.db.selectFrom('users').selectAll().orderBy('email').execute()
    return rows.map(toUser)
  }

  async create(input: NewUserInput): Promise<User> {
    const row = await this.db
      .insertInto('users')
      .values({
        email: input.email.trim().toLowerCase(),
        display_name: input.displayName.trim(),
        password_hash: input.passwordHash,
        role: input.role,
        active: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toUser(row)
  }

  async updateById(
    id: number,
    patch: { role?: UserRole; active?: boolean; passwordHash?: string; displayName?: string },
  ): Promise<User | undefined> {
    const values: Record<string, unknown> = {}
    if (patch.role !== undefined) values['role'] = patch.role
    if (patch.active !== undefined) values['active'] = patch.active ? 1 : 0
    if (patch.passwordHash !== undefined) values['password_hash'] = patch.passwordHash
    if (patch.displayName !== undefined) values['display_name'] = patch.displayName.trim()
    if (Object.keys(values).length === 0) {
      const row = await this.findById(id)
      return row ? toUser(row) : undefined
    }
    const row = await this.db
      .updateTable('users')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    return row ? toUser(row) : undefined
  }

  async countAdmins(): Promise<number> {
    const row = await this.db
      .selectFrom('users')
      .select(eb => eb.fn.countAll<number>().as('c'))
      .where('role', '=', 'admin')
      .where('active', '=', 1)
      .executeTakeFirstOrThrow()
    return Number(row.c)
  }

  static toPublic(row: UserRow): User {
    return toUser(row)
  }
}
