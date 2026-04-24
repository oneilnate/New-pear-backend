import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// MUST be set before any src/ import so db.ts opens :memory:
// vitest runs each test file in its own worker, so this takes effect before
// the module registry caches db.ts
process.env.FOODPOD_DB_PATH = ':memory:';

import { app } from '../src/server.js';

/**
 * Reset pod state before each suite run.
 * When bun test runs all files in the same process the :memory: DB is shared
 * across test files; we need an explicit reset so this file always starts clean.
 * We also ensure the demo user + pod exist in case another test file's beforeAll
 * inserted a different user first, preventing seedIfEmpty() from running.
 */
beforeAll(async () => {
  const { default: db } = await import('../src/db.js');
  db.run('DELETE FROM episodes');
  db.run('DELETE FROM meal_images');
  // Ensure demo user + pod exist (seed may not have run if another test added a user first)
  db.query(
    'INSERT OR IGNORE INTO users (id, email, name, profile, daily_targets) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run('usr_demo_01', 'demo@everbetter.com', 'Sarah Chen',
    JSON.stringify({ age: 32, weight_lbs: 140, height_in: 65, goals: ['weight_loss', 'energy'] }),
    JSON.stringify({ calories: 1800, protein_g: 120, carbs_g: 180, fat_g: 60 }));
  db.query(
    'INSERT OR IGNORE INTO pods (id, user_id, target_count, captured_count, status) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run('pod_demo_01', 'usr_demo_01', 7, 0, 'collecting');
  db.run("UPDATE pods SET captured_count = 0, status = 'collecting', failure_reason = NULL WHERE id = 'pod_demo_01'");
});

describe('Food Pod Backend', () => {
  describe('GET /api/health', () => {
    it('returns 200 with ok:true', async () => {
      const res = await app.fetch(new Request('http://localhost/api/health'));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; service: string; ts: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe('food-pod-backend');
      expect(typeof body.ts).toBe('string');
    });
  });

  describe('GET /api/pods/:id', () => {
    it('returns 200 with seeded pod shape', async () => {
      const res = await app.fetch(new Request('http://localhost/api/pods/pod_demo_01'));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        id: string;
        status: string;
        targetCount: number;
        capturedCount: number;
        recentSnaps: unknown[];
        episode: null;
      };
      expect(body.id).toBe('pod_demo_01');
      expect(body.status).toBe('collecting');
      expect(body.targetCount).toBe(7);
      expect(body.capturedCount).toBe(0);
      expect(Array.isArray(body.recentSnaps)).toBe(true);
      expect(body.episode).toBeNull();
    });

    it('returns 404 for unknown pod', async () => {
      const res = await app.fetch(new Request('http://localhost/api/pods/pod_unknown'));
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pods/:id/images', () => {
    // Minimal 1x1 JPEG bytes used for multipart upload tests
    const TINY_JPEG = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
      'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
      'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
      'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA' +
      'AAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA' +
      '/9oADAMBAAIRAxEAPwCwABmX/9k=',
      'base64'
    );

    it('returns 200 with imageId, sequenceNumber, capturedCount', async () => {
      const fd = new FormData();
      fd.append('image', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'meal.jpg');
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_demo_01/images', { method: 'POST', body: fd })
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        imageId: string;
        sequenceNumber: number;
        capturedCount: number;
      };
      expect(typeof body.imageId).toBe('string');
      expect(body.sequenceNumber).toBeGreaterThanOrEqual(1);
      expect(body.capturedCount).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 for unknown pod', async () => {
      const fd = new FormData();
      fd.append('image', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'meal.jpg');
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_nope/images', { method: 'POST', body: fd })
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pods/:id/complete', () => {
    // These tests verify pod/meal-count logic, not the pipeline.
    // Both keys are set so the credential guard passes; tests rely on captured_count < target.
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedEleven = process.env.ELEVENLABS_API_KEY;
    beforeAll(() => {
      process.env.GEMINI_API_KEY = 'dummy-key-for-complete-tests';
      process.env.ELEVENLABS_API_KEY = 'dummy-key-for-complete-tests';
    });
    afterAll(() => {
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
      else delete process.env.GEMINI_API_KEY;
      if (savedEleven !== undefined) process.env.ELEVENLABS_API_KEY = savedEleven;
      else delete process.env.ELEVENLABS_API_KEY;
    });

    it('returns 400 with not enough meals when capturedCount < targetCount', async () => {
      // After one image upload above, capturedCount is 1 which is still < 7
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_demo_01/complete', { method: 'POST' })
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; needed: number; captured: number };
      expect(body.error).toBe('not enough meals');
      expect(body.needed).toBe(7);
      expect(typeof body.captured).toBe('number');
    });

    it('returns 404 for unknown pod', async () => {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_nope/complete', { method: 'POST' })
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/pods/:id/episode', () => {
    it('returns 404 when no episode exists', async () => {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_demo_01/episode')
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('NO_EPISODE');
    });

    it('returns 404 for unknown pod on episode', async () => {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_unknown/episode')
      );
      expect(res.status).toBe(404);
    });
  });
});

