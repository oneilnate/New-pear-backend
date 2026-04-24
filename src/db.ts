/**
 * Database connection + schema initialization.
 *
 * Uses Bun's built-in `bun:sqlite` module, which is API-compatible with
 * better-sqlite3 and is fully supported in the Bun runtime.
 *
 * NOTE: better-sqlite3 (the npm package) uses a Node.js native addon (.node
 * binary) that Bun does not support (bun/issues/4290). bun:sqlite is the
 * correct choice for a Bun-first service and is listed in the locked decisions
 * alongside better-sqlite3 — the intent was a synchronous SQLite driver, which
 * bun:sqlite fulfils exactly.
 */
import { Database } from 'bun:sqlite';
import path from 'path';

const DB_PATH = process.env.FOODPOD_DB_PATH ?? path.join(process.cwd(), 'foodpod.db');

export const db = new Database(DB_PATH, { create: true });

// Enable WAL mode for better concurrency
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA foreign_keys = ON');

// Create schema
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    profile TEXT,
    daily_targets TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS pods (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    target_count INTEGER NOT NULL,
    captured_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'collecting',
    error_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    ready_at TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS meal_images (
    id TEXT PRIMARY KEY,
    pod_id TEXT NOT NULL REFERENCES pods(id),
    sequence_number INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    rating TEXT,
    uploaded_at TEXT DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    pod_id TEXT NOT NULL REFERENCES pods(id),
    title TEXT,
    summary_text TEXT,
    script_text TEXT,
    audio_path TEXT,
    duration_sec INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

export default db;
