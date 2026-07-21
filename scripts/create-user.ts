import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'
import { hashPassword } from '../src/auth/password.js'
import { UserRepository } from '../src/repositories/userRepository.js'
import type { UserRole } from '../src/db/schema.js'

const [email, displayName, role, password] = process.argv.slice(2)
const ROLES: UserRole[] = ['dispatcher', 'finance', 'admin']

if (!email || !displayName || !role || !password) {
  console.error('Usage: npm run create-user -- <email> <display-name> <dispatcher|finance|admin> <password>')
  process.exit(1)
}
if (!ROLES.includes(role as UserRole)) {
  console.error(`Invalid role '${role}'. Must be one of: ${ROLES.join(', ')}`)
  process.exit(1)
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.')
  process.exit(1)
}

const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
mkdirSync(dirname(databasePath), { recursive: true })
const db = createDatabase(databasePath)
try {
  await migrateToLatest(db)
  const repo = new UserRepository(db)
  if (await repo.findByEmail(email)) {
    console.error(`User with email '${email}' already exists.`)
    process.exit(1)
  }
  const user = await repo.create({
    email,
    displayName,
    role: role as UserRole,
    passwordHash: await hashPassword(password),
  })
  console.log(`Created ${user.role} account: ${user.email} (${user.displayName})`)
} finally {
  await db.destroy()
}
