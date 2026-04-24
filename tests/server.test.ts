import { describe, it, expect, beforeAll } from 'vitest';

// MUST be set before any src/ import so db.ts opens :memory:
// vitest runs each test file in its own worker, so this takes effect before
// the module registry caches db.ts
process.env.FOODPOD_DB_PATH = ':memory:';

import { app } from '../src/server.js';

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
    it('returns 200 with imageId, sequenceNumber, capturedCount', async () => {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_demo_01/images', { method: 'POST' })
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
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_nope/images', { method: 'POST' })
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pods/:id/complete', () => {
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
      expect(body.error).toBe('episode not ready');
    });

    it('returns 404 for unknown pod on episode', async () => {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_unknown/episode')
      );
      expect(res.status).toBe(404);
    });
  });
});

