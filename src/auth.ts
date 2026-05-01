/**
 * Token-based multi-user identity for the demo environment.
 *
 * No registration, no login. The bearer token IS the identity — any UUID
 * works. First call auto-creates a user row keyed on the token hash.
 *
 * If no Authorization header is present, falls back to the legacy
 * DEMO_USER_ID ('usr_demo_01') so existing single-user flows continue
 * to work without any changes.
 */
import crypto from 'crypto';
import db from './db.js';
import type { Context } from 'hono';

/** Fallback for requests with no Authorization header (legacy demo mode). */
const DEMO_USER_ID = 'usr_demo_01';

/** Default nutrition profile applied to every auto-created user. */
const DEFAULT_PROFILE = JSON.stringify({
  age: 30,
  goals: ['health', 'energy'],
});

const DEFAULT_TARGETS = JSON.stringify({
  calories: 2000,
  protein_g: 120,
  carbs_g: 200,
  fat_g: 65,
});

/**
 * Resolve the user ID from the request's Authorization header.
 *
 * - `Authorization: Bearer <token>` → deterministic user ID derived from token
 * - No header → 'usr_demo_01' (legacy single-user fallback)
 *
 * On first sight of a token, a users row is auto-created (INSERT OR IGNORE).
 */
export function resolveUserId(c: Context): string {
  const authHeader = c.req.header('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (!token) return DEMO_USER_ID;

  // Derive a stable user ID from the token (first 12 hex chars of SHA-256)
  const userId = 'usr_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);

  // Auto-create user on first sight — idempotent
  db.query(`
    INSERT OR IGNORE INTO users (id, email, name, profile, daily_targets)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run(
    userId,
    `${userId}@foodpod.demo`,
    'Sienna Chen',
    DEFAULT_PROFILE,
    DEFAULT_TARGETS,
  );

  return userId;
}
