import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing via Node's built-in scrypt (no native dependency).
 * Stored format: scrypt$N$r$p$saltHex$hashHex — parameters travel with the
 * hash so they can be raised later without invalidating existing users.
 */

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SALT_BYTES = 16

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  const salt = Buffer.from(parts[4]!, 'hex')
  const expected = Buffer.from(parts[5]!, 'hex')
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false
  const actual = await scryptAsync(password, salt, n, r, p)
  return timingSafeEqual(actual, expected)
}
