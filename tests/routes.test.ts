/**
 * tests/routes.test.ts — F4-E3
 *
 * Covers POST /api/pods/:id/complete and GET /api/pods/:id/episode
 * with a mocked runPipeline (no real Gemini/ElevenLabs calls).
 *
 * Also adds regression tests for the updated GET /api/pods/:id (episode field
 * when status='ready', failureReason field when status='failed').
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// Must be set before any src/ import
process.env.FOODPOD_DB_PATH = ':memory:';
process.env.FOODPOD_MEDIA_DIR = '/tmp/foodpod-routes-test';

import { app } from '../src/server.js';

// ── DB helpers ────────────────────────────────────────────────────────────

let db: Awaited<ReturnType<typeof getDb>>;
async function getDb() {
  const m = await import('../src/db.js');
  return m.default;
}

beforeAll(async () => {
  db = await getDb();
  // Ensure demo user + pod always exist (pipeline.test.ts may have polluted :memory: DB
  // with usr_test_01 before seedIfEmpty() ran, preventing auto-seed of pod_demo_01)
  db.query(
    'INSERT OR IGNORE INTO users (id, email, name, profile, daily_targets) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run('usr_demo_01', 'demo@everbetter.com', 'Sarah Chen',
    JSON.stringify({ age: 32, weight_lbs: 140, height_in: 65, goals: ['weight_loss'] }),
    JSON.stringify({ calories: 1800, protein_g: 120, carbs_g: 180, fat_g: 60 }));
  db.query(
    'INSERT OR IGNORE INTO pods (id, user_id, target_count, captured_count, status) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run('pod_demo_01', 'usr_demo_01', 7, 0, 'collecting');
});

// Reset pod state before each test
beforeEach(() => {
  db.run('DELETE FROM episodes');
  db.run('DELETE FROM meal_images');
  db.run(`UPDATE pods SET captured_count = 0, status = 'collecting', failure_reason = NULL WHERE id = 'pod_demo_01'`);
});

afterAll(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
});

// ── POST /api/pods/:id/complete ─────────────────────────────────────────────

describe('POST /api/pods/:id/complete', () => {
  it('returns 503 when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01/complete', { method: 'POST' })
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/missing credentials/);
  });

  it('returns 503 when ELEVENLABS_API_KEY is missing', async () => {
    process.env.GEMINI_API_KEY = 'dummy';
    delete process.env.ELEVENLABS_API_KEY;
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01/complete', { method: 'POST' })
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/missing credentials/);
  });

  it('returns 400 when captured_count < target_count', async () => {
    process.env.GEMINI_API_KEY = 'dummy';
    process.env.ELEVENLABS_API_KEY = 'dummy';
    // capturedCount=0, targetCount=7 — not ready
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01/complete', { method: 'POST' })
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; needed: number; captured: number };
    expect(body.error).toBe('not enough meals');
    expect(body.needed).toBe(7);
  });

  it('returns 404 for unknown pod', async () => {
    process.env.GEMINI_API_KEY = 'dummy';
    process.env.ELEVENLABS_API_KEY = 'dummy';
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_nope/complete', { method: 'POST' })
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with episode metadata when pipeline succeeds', async () => {
    process.env.GEMINI_API_KEY = 'dummy';
    process.env.ELEVENLABS_API_KEY = 'dummy';

    // Set pod to target count
    db.run(`UPDATE pods SET captured_count = 7 WHERE id = 'pod_demo_01'`);

    // Seed 7 fake image rows (no real files needed — pipeline is mocked)
    for (let i = 1; i <= 7; i++) {
      db.query(
        'INSERT OR REPLACE INTO meal_images (id, pod_id, sequence_number, image_path) VALUES (?1, ?2, ?3, ?4)'
      ).run(`img_routes_${i}`, 'pod_demo_01', i, `images/img_routes_${i}.jpg`);
    }

    // Mock the pipeline module
    const fakePipelineResult = {
      episodeId: 'ep_routes_test_01',
      audioPath: 'audio/ep_routes_test_01.mp3',
      durationSec: 120,
      title: 'Routes Test Episode',
      summary: 'A test summary.',
    };

    // Stub fetch to mock Gemini + ElevenLabs
    const savedFetch = globalThis.fetch;
    const fakeMp3 = new Uint8Array(100 * 16_000);
    fakeMp3[0] = 0xff; fakeMp3[1] = 0xfb; fakeMp3[2] = 0x90; fakeMp3[3] = 0x00;

    // Write a fake image file so Gemini stage can read it
    const fs = await import('fs');
    const path = await import('path');
    const imagesDir = path.join(process.env.FOODPOD_MEDIA_DIR!, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(
        path.join(process.env.FOODPOD_MEDIA_DIR!, 'images', `img_routes_${i}.jpg`),
        Buffer.from([0xff, 0xd8, 0xff, 0xe0])
      );
    }
    const audioDir = path.join(process.env.FOODPOD_MEDIA_DIR!, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });

    globalThis.fetch = async (url: unknown, init?: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        const geminiData = {
          title: 'Routes Test Episode',
          summary: 'A test summary.',
          script: 'This is the test script.',
          highlights: ['fiber gap'],
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify(geminiData) }] } }],
          }),
          text: async () => '',
        } as unknown as Response;
      }
      if (urlStr.includes('api.elevenlabs.io')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(fakeMp3); c.close(); },
          }),
          text: async () => '',
        } as unknown as Response;
      }
      return savedFetch(url as RequestInfo, init as RequestInit);
    };

    try {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_demo_01/complete', { method: 'POST' })
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        episodeId: string;
        audioUrl: string;
        durationSec: number;
        title: string;
        summary: string;
      };
      expect(body.episodeId).toMatch(/^ep_/);
      expect(body.audioUrl).toMatch(/\/media\/audio\/.+\.mp3$/);
      expect(typeof body.durationSec).toBe('number');
      expect(body.durationSec).toBeGreaterThan(0);
      expect(typeof body.title).toBe('string');
      expect(typeof body.summary).toBe('string');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('returns 500 when pipeline throws a generic error', async () => {
    process.env.GEMINI_API_KEY = 'dummy';
    process.env.ELEVENLABS_API_KEY = 'dummy';
    db.run(`UPDATE pods SET captured_count = 7 WHERE id = 'pod_demo_01'`);

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url: unknown) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as unknown as Response;
      }
      return savedFetch(url as RequestInfo);
    };

    // Need at least 1 image file so Gemini stage gets past image load
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    const imagesDir = path.join(process.env.FOODPOD_MEDIA_DIR!, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    for (let i = 1; i <= 7; i++) {
      const imgPath = path.join(imagesDir, `img_routes_${i}.jpg`);
      if (!fs.existsSync(imgPath)) {
        fs.writeFileSync(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      }
      db.query(
        'INSERT OR REPLACE INTO meal_images (id, pod_id, sequence_number, image_path) VALUES (?1, ?2, ?3, ?4)'
      ).run(`img_routes500_${i}`, 'pod_demo_01', i, `images/img_routes_${i}.jpg`);
    }

    try {
      const res = await app.fetch(
        new Request('http://localhost/api/pods/pod_demo_01/complete', { method: 'POST' })
      );
      expect(res.status).toBe(500);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── GET /api/pods/:id/episode ───────────────────────────────────────────────

describe('GET /api/pods/:id/episode', () => {
  it('returns 404 with error:NO_EPISODE when no episode exists', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01/episode')
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('NO_EPISODE');
  });

  it('returns 404 for unknown pod', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_nope/episode')
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with episode fields when episode exists', async () => {
    // Insert a fake episode row
    db.query(
      `INSERT INTO episodes
        (id, pod_id, title, summary_text, script_text, audio_path, duration_sec, highlights, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).run(
      'ep_route_test_01', 'pod_demo_01',
      'Episode Title', 'Episode Summary', 'Episode Script',
      'audio/ep_route_test_01.mp3', 120,
      JSON.stringify(['fiber gap']),
      new Date().toISOString()
    );

    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01/episode')
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      episodeId: string;
      audioUrl: string | null;
      durationSec: number;
      title: string;
      summary: string;
      highlights: string[];
      createdAt: string;
    };
    expect(body.episodeId).toBe('ep_route_test_01');
    expect(body.audioUrl).toMatch(/\/media\/audio\/ep_route_test_01\.mp3/);
    expect(body.durationSec).toBe(120);
    expect(body.title).toBe('Episode Title');
    expect(body.summary).toBe('Episode Summary');
    expect(Array.isArray(body.highlights)).toBe(true);
    expect(body.highlights[0]).toBe('fiber gap');
    expect(typeof body.createdAt).toBe('string');
  });
});

// ── GET /api/pods/:id — episode + failureReason fields ─────────────────────

describe('GET /api/pods/:id — updated fields', () => {
  it('includes episode field when status=ready and episode row exists', async () => {
    db.run(`UPDATE pods SET status = 'ready', captured_count = 7 WHERE id = 'pod_demo_01'`);
    db.query(
      `INSERT INTO episodes
        (id, pod_id, title, summary_text, script_text, audio_path, duration_sec, highlights, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).run(
      'ep_pod_get_01', 'pod_demo_01',
      'Get Test', 'Summary', 'Script',
      'audio/ep_pod_get_01.mp3', 90,
      JSON.stringify(['protein gap']),
      new Date().toISOString()
    );

    const res = await app.fetch(new Request('http://localhost/api/pods/pod_demo_01'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      status: string;
      episode: {
        episodeId: string;
        audioUrl: string;
        durationSec: number;
        title: string;
        summary: string;
        highlights: string[];
      } | null;
    };
    expect(body.status).toBe('ready');
    expect(body.episode).not.toBeNull();
    expect(body.episode!.episodeId).toBe('ep_pod_get_01');
    expect(body.episode!.audioUrl).toMatch(/\/media\/audio\/ep_pod_get_01\.mp3/);
  });

  it('includes failureReason field when status=failed', async () => {
    db.run(`UPDATE pods SET status = 'failed', failure_reason = 'Gemini quota exceeded' WHERE id = 'pod_demo_01'`);

    const res = await app.fetch(new Request('http://localhost/api/pods/pod_demo_01'));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; failureReason?: string };
    expect(body.status).toBe('failed');
    expect(body.failureReason).toBe('Gemini quota exceeded');
  });

  it('episode is null when status=collecting (even if episode row existed)', async () => {
    // Pod is still collecting, no episode should appear
    const res = await app.fetch(new Request('http://localhost/api/pods/pod_demo_01'));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; episode: null };
    expect(body.status).toBe('collecting');
    expect(body.episode).toBeNull();
  });
});

// ── GET /media/audio/:filename ──────────────────────────────────────────────

describe('GET /media/audio/:filename', () => {
  it('returns 404 for a non-existent file', async () => {
    const res = await app.fetch(new Request('http://localhost/media/audio/nonexistent.mp3'));
    expect(res.status).toBe(404);
  });

  it('returns 400 for path traversal attempt', async () => {
    const res = await app.fetch(new Request('http://localhost/media/audio/..%2F..%2Fetc%2Fpasswd'));
    expect(res.status).toBe(400);
  });

  it('returns 200 with audio/mpeg for an existing MP3', async () => {
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    const audioDir = path.join(process.env.FOODPOD_MEDIA_DIR!, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const fakeMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]);
    fs.writeFileSync(path.join(audioDir, 'test_audio.mp3'), fakeMp3);

    const res = await app.fetch(new Request('http://localhost/media/audio/test_audio.mp3'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
  });
});

