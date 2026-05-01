/**
 * Tests for src/pipeline/run.ts — F4-E3 pipeline orchestrator.
 *
 * Unit tests: mock Gemini + ElevenLabs, verify full flow, DB writes, status transitions.
 * Integration test (gated): real 3-image pod → real Gemini + ElevenLabs → MP3 on disk + episode row.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Environment setup (must happen before any src/ import) ──────────────────────

process.env.FOODPOD_DB_PATH = ':memory:';

let testMediaDir: string;
let savedFetch: typeof globalThis.fetch;
let db: Awaited<ReturnType<typeof import('../src/db.js')['default'] extends infer T ? T extends object ? () => Promise<typeof import('../src/db.js')['default']> : never : never>>;

beforeAll(async () => {
  testMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodpod-pipeline-test-'));
  process.env.FOODPOD_MEDIA_DIR = testMediaDir;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.ELEVENLABS_API_KEY = 'test-eleven-key';

  savedFetch = globalThis.fetch;

  // Import db after env is set
  const dbModule = await import('../src/db.js');
  const dbInstance = dbModule.default;

  // Seed: user for all tests
  dbInstance.query(
    'INSERT OR IGNORE INTO users (id, email, name, profile, daily_targets) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run(
    'usr_test_01',
    'test@test.com',
    'Test User',
    JSON.stringify({ age: 30 }),
    JSON.stringify({ calories: 2000, protein_g: 100 })
  );
});

afterAll(() => {
  globalThis.fetch = savedFetch;
  fs.rmSync(testMediaDir, { recursive: true, force: true });
  delete process.env.FOODPOD_MEDIA_DIR;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
});

// ── Helper: create a fresh pod for each test ─────────────────────────────────────

async function makePod(podId: string, capturedCount = 3, targetCount = 3, status = 'collecting'): Promise<void> {
  const { default: dbInstance } = await import('../src/db.js');
  dbInstance.query(
    'INSERT OR REPLACE INTO pods (id, user_id, target_count, captured_count, status) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).run(podId, 'usr_test_01', targetCount, capturedCount, status);

  const imagesDir = path.join(testMediaDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  for (let i = 1; i <= capturedCount; i++) {
    const imageId = `img_test_${podId}_${i}`;
    const imagePath = `images/${imageId}.jpg`;
    // Write a tiny placeholder JPEG
    fs.writeFileSync(path.join(testMediaDir, imagePath), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    dbInstance.query(
      'INSERT OR REPLACE INTO meal_images (id, pod_id, sequence_number, image_path) VALUES (?1, ?2, ?3, ?4)'
    ).run(imageId, podId, i, imagePath);
  }
}

// ── Fake MP3 helper ───────────────────────────────────────────────────────────────

/** Fake 100-second MP3 (MPEG1 Layer3 128 kbps byte-rate header). */
function fakeMp3(): Uint8Array {
  const buf = new Uint8Array(100 * 16_000);
  buf[0] = 0xff; buf[1] = 0xfb; buf[2] = 0x90; buf[3] = 0x00;
  return buf;
}

function makeReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); c.close(); },
  });
}

// ── Mock helpers ────────────────────────────────────────────────────────────

interface GeminiResponseData {
  title: string;
  summary: string;
  script: string;
  highlights: string[];
}

/** Mock both Gemini and ElevenLabs fetch calls. */
function mockBothApis(geminiResult?: GeminiResponseData): void {
  const geminiResponse: GeminiResponseData = geminiResult ?? {
    title: 'Test Episode',
    summary: 'A summary of your meals.',
    script: 'Welcome to your weekly nutrition podcast. Here are your highlights.',
    highlights: ['fiber gap', 'protein gap'],
  };

  const geminiEnvelope = JSON.stringify({
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify(geminiResponse) }],
      },
    }],
  });

  globalThis.fetch = async (url: unknown, init?: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (_h: string) => 'application/json' },
        json: async () => JSON.parse(geminiEnvelope),
        text: async () => geminiEnvelope,
      } as unknown as Response;
    }
    if (urlStr.includes('api.elevenlabs.io')) {
      return {
        ok: true,
        status: 200,
        body: makeReadableStream(fakeMp3()),
        headers: { get: (_h: string) => null },
        text: async () => '',
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init as RequestInit);
  };
}

/** Mock Gemini to fail. ElevenLabs never gets called. */
function mockGeminiFailure(errMsg: string): void {
  globalThis.fetch = async (url: unknown, init?: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      return {
        ok: false,
        status: 500,
        text: async () => errMsg,
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init as RequestInit);
  };
}

/** Mock ElevenLabs to fail. Gemini succeeds. */
function mockElevenLabsFailure(errMsg: string): void {
  globalThis.fetch = async (url: unknown, init?: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      const geminiResponse: GeminiResponseData = {
        title: 'Test Episode',
        summary: 'Summary.',
        script: 'Script.',
        highlights: ['fiber'],
      };
      const envelope = JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(geminiResponse) }] } }],
      });
      return {
        ok: true,
        status: 200,
        headers: { get: (_h: string) => 'application/json' },
        json: async () => JSON.parse(envelope),
        text: async () => envelope,
      } as unknown as Response;
    }
    if (urlStr.includes('api.elevenlabs.io')) {
      return {
        ok: false,
        status: 503,
        headers: { get: (_h: string) => null },
        text: async () => errMsg,
        body: null,
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init as RequestInit);
  };
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('runPipeline — unit (mocked Gemini + ElevenLabs)', () => {
  it('full happy path: DB writes correct, status transitions collecting→generating→ready', async () => {
    const podId = `pod_unit_happy_${Date.now()}`;
    await makePod(podId);
    mockBothApis();

    const { runPipeline } = await import('../src/pipeline/run.js');
    const { default: dbInstance } = await import('../src/db.js');
    const result = await runPipeline(podId);

    // Return shape
    expect(result.episodeId).toMatch(/^ep_/);
    expect(typeof result.audioPath).toBe('string');
    expect(result.audioPath).toMatch(/^audio\/.+\.mp3$/);
    expect(typeof result.durationSec).toBe('number');
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.title).toBe('Test Episode');
    expect(result.summary).toBe('A summary of your meals.');

    // Pod status = ready
    const pod = dbInstance.query('SELECT status, failure_reason FROM pods WHERE id = ?').get(podId) as
      { status: string; failure_reason: string | null };
    expect(pod.status).toBe('ready');
    expect(pod.failure_reason).toBeNull();

    // Episode row exists
    const ep = dbInstance.query(
      'SELECT id, title, summary_text, script_text, audio_path, duration_sec, highlights FROM episodes WHERE pod_id = ?'
    ).get(podId) as {
      id: string; title: string; summary_text: string; script_text: string;
      audio_path: string; duration_sec: number; highlights: string;
    };
    expect(ep).toBeDefined();
    expect(ep.id).toBe(result.episodeId);
    expect(ep.title).toBe('Test Episode');
    expect(ep.summary_text).toBe('A summary of your meals.');
    expect(ep.audio_path).toMatch(/^audio\//)
    expect(ep.duration_sec).toBeGreaterThan(0);
    const highlights = JSON.parse(ep.highlights) as string[];
    expect(Array.isArray(highlights)).toBe(true);

    // MP3 file on disk
    const mp3Path = path.join(testMediaDir, result.audioPath);
    expect(fs.existsSync(mp3Path)).toBe(true);
    expect(fs.statSync(mp3Path).size).toBeGreaterThan(0);
  });

  it('Gemini failure → pod.status=failed, failure_reason set, error thrown', async () => {
    const podId = `pod_unit_gemini_fail_${Date.now()}`;
    await makePod(podId);
    mockGeminiFailure('Gemini quota exceeded');

    const { runPipeline } = await import('../src/pipeline/run.js');
    const { default: dbInstance } = await import('../src/db.js');
    await expect(runPipeline(podId)).rejects.toThrow(/Gemini/);

    const pod = dbInstance.query('SELECT status, failure_reason FROM pods WHERE id = ?').get(podId) as
      { status: string; failure_reason: string | null };
    expect(pod.status).toBe('failed');
    expect(pod.failure_reason).toBeTruthy();
    expect(pod.failure_reason).toMatch(/Gemini/);
  });

  it('ElevenLabs failure → pod.status=failed, failure_reason set, error thrown', async () => {
    const podId = `pod_unit_eleven_fail_${Date.now()}`;
    await makePod(podId);
    mockElevenLabsFailure('ElevenLabs service unavailable');

    const { runPipeline } = await import('../src/pipeline/run.js');
    const { default: dbInstance } = await import('../src/db.js');
    await expect(runPipeline(podId)).rejects.toThrow(/ElevenLabs|503/);

    const pod = dbInstance.query('SELECT status, failure_reason FROM pods WHERE id = ?').get(podId) as
      { status: string; failure_reason: string | null };
    expect(pod.status).toBe('failed');
    expect(pod.failure_reason).toBeTruthy();
  });

  it('pod not at target → throws PodNotReadyError, no status change', async () => {
    const podId = `pod_unit_not_ready_${Date.now()}`;
    // Only 2 images captured, target=3
    await makePod(podId, 2, 3);
    mockBothApis();

    const { runPipeline, PodNotReadyError } = await import('../src/pipeline/run.js');
    const { default: dbInstance } = await import('../src/db.js');
    await expect(runPipeline(podId)).rejects.toThrow(PodNotReadyError);

    // Status unchanged
    const pod = dbInstance.query('SELECT status FROM pods WHERE id = ?').get(podId) as { status: string };
    expect(pod.status).toBe('collecting');
  });

  it('missing GEMINI_API_KEY → throws with missing credentials message', async () => {
    const podId = `pod_unit_no_gemini_${Date.now()}`;
    await makePod(podId);
    delete process.env.GEMINI_API_KEY;

    const { runPipeline } = await import('../src/pipeline/run.js');
    await expect(runPipeline(podId)).rejects.toThrow(/missing credentials/);
  });

  it('missing ELEVENLABS_API_KEY → throws with missing credentials message', async () => {
    const podId = `pod_unit_no_eleven_${Date.now()}`;
    await makePod(podId);
    delete process.env.ELEVENLABS_API_KEY;

    const { runPipeline } = await import('../src/pipeline/run.js');
    await expect(runPipeline(podId)).rejects.toThrow(/missing credentials/);
  });

  it('passes Gemini script to ElevenLabs unchanged — no swap segments appended', async () => {
    const podId = `pod_unit_swaps_${Date.now()}`;
    await makePod(podId);

    mockBothApis({
      title: 'Script Passthrough Test',
      summary: 'Summary.',
      script: 'Your diet is low in fiber.',
      highlights: ['You are not getting enough fiber in your meals', 'protein could be improved'],
    });

    // Capture the script sent to ElevenLabs
    let capturedScript = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: unknown, init?: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('api.elevenlabs.io')) {
        const body = JSON.parse((init as RequestInit).body as string) as { text: string };
        capturedScript = body.text;
      }
      return origFetch(url as RequestInfo, init as RequestInit);
    };

    const { runPipeline } = await import('../src/pipeline/run.js');
    await runPipeline(podId);

    // Script should be passed through exactly as Gemini produced it — no swap appendage
    expect(capturedScript).toContain('Your diet is low in fiber');
    expect(capturedScript).not.toContain('Try swapping');
    expect(capturedScript).not.toContain('Here are a few easy swaps');
  });
});

// ── Integration test (gated by both keys) ────────────────────────────────────

const LIVE_GEMINI = process.env.GEMINI_API_KEY &&
  !process.env.GEMINI_API_KEY.startsWith('test-')
  ? process.env.GEMINI_API_KEY : null;

const LIVE_ELEVEN = process.env.ELEVENLABS_API_KEY &&
  !process.env.ELEVENLABS_API_KEY.startsWith('test-')
  ? process.env.ELEVENLABS_API_KEY : null;

const bothLive = LIVE_GEMINI && LIVE_ELEVEN;

describe.skipIf(!bothLive)(
  'runPipeline — integration (live Gemini + ElevenLabs)',
  () => {
    beforeAll(() => {
      globalThis.fetch = savedFetch;
      if (LIVE_GEMINI) process.env.GEMINI_API_KEY = LIVE_GEMINI;
      if (LIVE_ELEVEN) process.env.ELEVENLABS_API_KEY = LIVE_ELEVEN;
    });

    it(
      'synthesizes a real 3-image pod → MP3 on disk + episodes row',
      { timeout: 120_000 },
      async () => {
        const { default: dbInstance } = await import('../src/db.js');
        const podId = `pod_integration_${Date.now()}`;

        dbInstance.query(
          'INSERT OR REPLACE INTO pods (id, user_id, target_count, captured_count, status) VALUES (?1, ?2, ?3, ?4, ?5)'
        ).run(podId, 'usr_test_01', 3, 3, 'collecting');

        const fixtureDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'meals');
        const fixtureFiles = fs.readdirSync(fixtureDir)
          .filter((f: string) => f.endsWith('.jpg'))
          .slice(0, 3);

        const imagesDir = path.join(testMediaDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        fixtureFiles.forEach((file: string, idx: number) => {
          const imageId = `img_integ_${idx + 1}`;
          const dest = path.join(imagesDir, `${imageId}.jpg`);
          fs.copyFileSync(path.join(fixtureDir, file), dest);
          dbInstance.query(
            'INSERT OR REPLACE INTO meal_images (id, pod_id, sequence_number, image_path) VALUES (?1, ?2, ?3, ?4)'
          ).run(imageId, podId, idx + 1, `images/${imageId}.jpg`);
        });

        const { runPipeline } = await import('../src/pipeline/run.js');
        const result = await runPipeline(podId);

        expect(result.episodeId).toMatch(/^ep_/);
        expect(result.audioPath).toMatch(/^audio\/.+\.mp3$/);
        expect(result.durationSec).toBeGreaterThan(0);
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.summary.length).toBeGreaterThan(0);

        const mp3 = path.join(testMediaDir, result.audioPath);
        expect(fs.existsSync(mp3)).toBe(true);
        expect(fs.statSync(mp3).size).toBeGreaterThan(1_000);

        const ep = dbInstance.query(
          'SELECT id, title, audio_path, duration_sec FROM episodes WHERE pod_id = ?'
        ).get(podId) as { id: string; title: string; audio_path: string; duration_sec: number };
        expect(ep).toBeDefined();
        expect(ep.id).toBe(result.episodeId);
        expect(ep.duration_sec).toBeGreaterThan(0);

        const pod = dbInstance.query('SELECT status FROM pods WHERE id = ?').get(podId) as { status: string };
        expect(pod.status).toBe('ready');
      }
    );
  }
);

