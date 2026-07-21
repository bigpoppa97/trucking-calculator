import { Kysely, sql } from 'kysely'

/**
 * Auth tables (PRD §5.1: email+password, roles dispatcher/finance/admin,
 * no self-registration). Sessions are server-side rows referenced by an
 * opaque token in an httpOnly cookie.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('email', 'text', col => col.notNull().unique())
    .addColumn('display_name', 'text', col => col.notNull())
    .addColumn('password_hash', 'text', col => col.notNull())
    .addColumn('role', 'text', col =>
      col.notNull().check(sql`role IN ('dispatcher', 'finance', 'admin')`),
    )
    .addColumn('active', 'integer', col => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute()

  await db.schema
    .createTable('sessions')
    .addColumn('token', 'text', col => col.primaryKey())
    .addColumn('user_id', 'integer', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('expires_at', 'text', col => col.notNull())
    .execute()

  await db.schema.createIndex('sessions_user_id_idx').on('sessions').column('user_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('sessions').execute()
  await db.schema.dropTable('users').execute()
}
