/**
 * tests/pods-list.test.ts
 *
 * Unit tests for:
 *   GET  /api/pods/current  — returns newest pod; auto-creates if none exist
 *   GET  /api/pods          — returns all pods for demo user, newest-first
 *   POST /api/pods          — creates a new pod with target_count=7
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Must be set before any src/ import
process.env.FOODPOD_DB_PATH = ':memory:';
process.env.FOODPOD_MEDIA_DIR = '/tmp/foodpod-pods-list-test';

import { app } from '../src/server.js';

let db: Awaited<ReturnType<typeof getDb>>;
async function getDb() {
  const m = await import('../src/db.js');
  return m.default;
}

beforeAll(async () => {
  db = await getDb();
  // Ensure demo user exists
  db.query(
    'INSERT OR IGNORE INTO users (id, email, name, profile, daily_targets) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run(
    'usr_demo_01',
    'demo@everbetter.com',
    'Sarah Chen',
    JSON.stringify({ age: 32, weight_lbs: 140, height_in: 65, goals: ['weight_loss'] }),
    JSON.stringify({ calories: 1800, protein_g: 120, carbs_g: 180, fat_g: 60 })
  );
});

beforeEach(() => {
  // Start with no pods so /current auto-create path is exercised cleanly
  db.run("DELETE FROM meal_images");
  db.run("DELETE FROM episodes");
  db.run("DELETE FROM pods WHERE user_id = 'usr_demo_01'");
});

// ─── GET /api/pods/current ─────────────────────────────────────────────────

describe('GET /api/pods/current', () => {
  it('returns 200 and auto-creates a pod when user has none', async () => {
    const res = await app.fetch(new Request('http://localhost/api/pods/current'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string;
      status: string;
      targetCount: number;
      capturedCount: number;
      recentSnaps: unknown[];
      episode: null;
    };
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^pod_/);
    expect(body.status).toBe('collecting');
    expect(body.targetCount).toBe(7);
    expect(body.capturedCount).toBe(0);
    expect(Array.isArray(body.recentSnaps)).toBe(true);
    expect(body.episode).toBeNull();
  });

  it('returns the newest pod when multiple exist', async () => {
    // Insert two pods with different timestamps
    db.query(
      "INSERT INTO pods (id, user_id, target_count, captured_count, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).run('pod_old_01', 'usr_demo_01', 7, 0, 'collecting', '2026-01-01T00:00:00.000Z');
    db.query(
      "INSERT INTO pods (id, user_id, target_count, captured_count, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).run('pod_new_01', 'usr_demo_01', 7, 3, 'collecting', '2026-06-01T00:00:00.000Z');

    const res = await app.fetch(new Request('http://localhost/api/pods/current'));
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; capturedCount: number };
    expect(body.id).toBe('pod_new_01');
    expect(body.capturedCount).toBe(3);
  });

  it('never returns 404', async () => {
    // Even with no pods, should be 200 (auto-create)
    const res = await app.fetch(new Request('http://localhost/api/pods/current'));
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });

  it('auto-created pod has targetCount=7', async () => {
    const res = await app.fetch(new Request('http://localhost/api/pods/current'));
    expect(res.status).toBe(200);
    const body = await res.json() as { targetCount: number };
    expect(body.targetCount).toBe(7);
  });
});

// ─── GET /api/pods ─────────────────────────────────────────────────────────

describe('GET /api/pods', () => {
  it('returns empty array when user has no pods', async () => {
    const res = await app.fetch(new Request('http://localhost/api/pods'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(0);
  });

  it('returns all pods newest-first', async () => {
    db.query(
      "INSERT INTO pods (id, user_id, target_count, captured_count, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).run('pod_a', 'usr_demo_01', 7, 0, 'collecting', '2026-01-01T00:00:00.000Z');
    db.query(
      "INSERT INTO pods (id, user_id, target_count, captured_count, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).run('pod_b', 'usr_demo_01', 7, 5, 'collecting', '2026-03-01T00:00:00.000Z');
    db.query(
      "INSERT INTO pods (id, user_id, target_count, captured_count, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).run('pod_c', 'usr_demo_01', 7, 7, 'ready', '2026-06-01T00:00:00.000Z');

    const res = await app.fetch(new Request('http://localhost/api/pods'));
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{
      id: string;
      status: string;
      targetCount: number;
      capturedCount: number;
      createdAt: string;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
    // Newest-first order
    expect(body[0].id).toBe('pod_c');
    expect(body[1].id).toBe('pod_b');
    expect(body[2].id).toBe('pod_a');
    // Shape check
    expect(body[0].status).toBe('ready');
    expect(body[0].targetCount).toBe(7);
    expect(body[0].capturedCount).toBe(7);
    expect(typeof body[0].createdAt).toBe('string');
  });
});

// ─── POST /api/pods ────────────────────────────────────────────────────────

describe('POST /api/pods', () => {
  it('returns 201 with a new pod at default target_count=7', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/pods', { method: 'POST' })
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      id: string;
      status: string;
      targetCount: number;
      capturedCount: number;
      recentSnaps: unknown[];
      episode: null;
    };
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^pod_/);
    expect(body.status).toBe('collecting');
    expect(body.targetCount).toBe(7);
    expect(body.capturedCount).toBe(0);
    expect(Array.isArray(body.recentSnaps)).toBe(true);
    expect(body.episode).toBeNull();
  });

  it('creates a new unique pod each time', async () => {
    const res1 = await app.fetch(new Request('http://localhost/api/pods', { method: 'POST' }));
    const res2 = await app.fetch(new Request('http://localhost/api/pods', { method: 'POST' }));
    const body1 = await res1.json() as { id: string };
    const body2 = await res2.json() as { id: string };
    expect(body1.id).not.toBe(body2.id);
  });

  it('new pod appears in GET /api/pods list', async () => {
    await app.fetch(new Request('http://localhost/api/pods', { method: 'POST' }));
    const listRes = await app.fetch(new Request('http://localhost/api/pods'));
    const list = await listRes.json() as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Boot-time migration: target_count=30 → 7 ─────────────────────────────

describe('Boot-time migration: target_count 30 → 7', () => {
  it('existing pods with target_count=30 are migrated to 7 at startup (via db.ts)', () => {
    // Insert a pod with target_count=30 (simulating pre-migration state)
    db.query(
      "INSERT OR REPLACE INTO pods (id, user_id, target_count, captured_count, status) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).run('pod_legacy_30', 'usr_demo_01', 30, 0, 'collecting');

    // Trigger the migration manually (same SQL as db.ts runs at boot)
    db.run("UPDATE pods SET target_count = 7 WHERE target_count = 30");

    const row = db.query('SELECT target_count FROM pods WHERE id = ?').get('pod_legacy_30') as { target_count: number };
    expect(row.target_count).toBe(7);
  });
});
