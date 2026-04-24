/**
 * Tests for src/pipeline/elevenlabs.ts
 *
 * Unit tests: mock fetch — always run (no ELEVENLABS_API_KEY required).
 * Integration test: gated by ELEVENLABS_API_KEY env var; skipped in CI if absent.
 *
 * NOTE: Uses direct globalThis.fetch replacement compatible with Bun's test runner.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Test media dir ────────────────────────────────────────────────────────────

let testMediaDir: string;
let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  testMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodpod-elevenlabs-test-'));
  process.env.FOODPOD_MEDIA_DIR = testMediaDir;
  process.env.ELEVENLABS_API_KEY = 'test-key-mock';
  savedFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = savedFetch;
  fs.rmSync(testMediaDir, { recursive: true, force: true });
  delete process.env.FOODPOD_MEDIA_DIR;
  delete process.env.ELEVENLABS_API_KEY;
});

afterEach(() => {
  // Restore real fetch after each test to avoid leaking mocks
  globalThis.fetch = savedFetch;
  // Restore API key in case a test deleted it
  process.env.ELEVENLABS_API_KEY = 'test-key-mock';
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal buffer that looks like an MP3 file of the given approximate
 * byte size. The first 4 bytes are a valid MPEG1 Layer3 frame header so that
 * the byte-rate estimator (128 kbps → 16 000 bytes/sec) computes a
 * reasonable duration.
 */
function buildFakeMp3(targetBytes: number): Uint8Array {
  // FF FB 90 00 → MPEG1, Layer3, 128 kbps, 44100 Hz, stereo, no padding
  const header = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const buf = new Uint8Array(Math.max(targetBytes, 4));
  buf.set(header, 0);
  return buf;
}

/** ~30 s at 128 kbps */
const MP3_30S = buildFakeMp3(30 * 16_000);
/** ~100 s at 128 kbps (within 60-240 s window) */
const MP3_100S = buildFakeMp3(100 * 16_000);
/** ~300 s at 128 kbps (exceeds 240 s limit) */
const MP3_300S = buildFakeMp3(300 * 16_000);

function makeReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Replace globalThis.fetch with a function that always returns the given body. */
function stubFetchSuccess(body: Uint8Array): void {
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: makeReadableStream(body),
      text: async () => '',
    }) as unknown as Response;
}

/** Track fetch calls so we can inspect arguments. */
interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetchSuccessTracked(
  body: Uint8Array,
  calls: FetchCall[]
): void {
  globalThis.fetch = async (url: unknown, init?: unknown) => {
    calls.push({ url: url as string, init: (init ?? {}) as RequestInit });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: makeReadableStream(body),
      text: async () => '',
    } as unknown as Response;
  };
}

/**
 * Stub fetch with a sequence of responses (each call consumes the next entry).
 * Falls back to the last entry for any extra calls.
 */
type FetchResponse = { ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; text?: () => Promise<string> };

function stubFetchSequence(responses: Array<() => FetchResponse>): void {
  let idx = 0;
  globalThis.fetch = async () => {
    const resp = responses[Math.min(idx, responses.length - 1)]();
    idx++;
    return resp as unknown as Response;
  };
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('synthesizeAudio — unit (mocked fetch)', () => {
  it('POSTs to the correct ElevenLabs endpoint with correct headers + body shape', async () => {
    const calls: FetchCall[] = [];
    stubFetchSuccessTracked(MP3_30S, calls);

    const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');
    await synthesizeAudio('Hello world. This is a test.', 'ep_unit_shape');

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const { url, init } = calls[0];

    // Correct endpoint with Sarah voice ID
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL'
    );

    // Required headers
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('test-key-mock');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('audio/mpeg');

    // Body shape: correct model + voice settings
    const parsedBody = JSON.parse(init.body as string) as {
      text: string;
      model_id: string;
      voice_settings: { stability: number; similarity_boost: number };
    };
    expect(parsedBody.text).toBe('Hello world. This is a test.');
    expect(parsedBody.model_id).toBe('eleven_turbo_v2_5');
    expect(parsedBody.voice_settings.stability).toBe(0.5);
    expect(parsedBody.voice_settings.similarity_boost).toBe(0.75);
  });

  it('returns audioPath + durationSec and writes MP3 to disk', async () => {
    stubFetchSuccess(MP3_100S);
    const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');

    const result = await synthesizeAudio('Some script text.', 'ep_unit_write');

    expect(result.audioPath).toBe('audio/ep_unit_write.mp3');
    expect(typeof result.durationSec).toBe('number');
    expect(result.durationSec).toBeGreaterThan(0);

    const fullPath = path.join(testMediaDir, 'audio', 'ep_unit_write.mp3');
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.statSync(fullPath).size).toBeGreaterThan(0);
  });

  it('truncates script and retries when audio is too long, then succeeds', async () => {
    const callCount = { n: 0 };
    const longScript = 'word '.repeat(300).trim(); // ~1500 chars

    // Call 1 → 300 s (too long), Call 2 → 100 s (OK)
    stubFetchSequence([
      () => ({ ok: true, status: 200, body: makeReadableStream(MP3_300S) }),
      () => ({ ok: true, status: 200, body: makeReadableStream(MP3_100S) }),
    ]);

    // Track the bodies sent to measure truncation
    const bodies: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: unknown, init?: unknown) => {
      const i = init as RequestInit;
      bodies.push(JSON.parse(i.body as string).text as string);
      callCount.n++;
      return origFetch(url as RequestInfo, init as RequestInit);
    };

    const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');
    const result = await synthesizeAudio(longScript, 'ep_unit_retry_ok');

    expect(callCount.n).toBe(2);
    // Second call must have a shorter script
    expect(bodies[1].length).toBeLessThan(bodies[0].length);

    expect(result.audioPath).toBe('audio/ep_unit_retry_ok.mp3');
    expect(result.durationSec).toBeGreaterThan(0);
  });

  it('throws with descriptive error after 2 retries still too long', async () => {
    // All 3 attempts (initial + 2 retries) return 300 s audio
    stubFetchSequence([
      () => ({ ok: true, status: 200, body: makeReadableStream(MP3_300S) }),
      () => ({ ok: true, status: 200, body: makeReadableStream(MP3_300S) }),
      () => ({ ok: true, status: 200, body: makeReadableStream(MP3_300S) }),
    ]);

    const callCount = { n: 0 };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: unknown, init?: unknown) => {
      callCount.n++;
      return origFetch(url as RequestInfo, init as RequestInit);
    };

    const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');
    const longScript = 'word '.repeat(500).trim();

    await expect(synthesizeAudio(longScript, 'ep_unit_bail')).rejects.toThrow(
      /exceeds maximum 240s after 3 attempt/i
    );

    // All 3 attempts must have fired
    expect(callCount.n).toBe(3);
  });

  it('throws immediately when ELEVENLABS_API_KEY is missing', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');

    await expect(synthesizeAudio('test', 'ep_no_key')).rejects.toThrow(
      /missing credentials/i
    );
  });

  it('throws on non-2xx API response without retrying', async () => {
    stubFetchSequence([
      () => ({
        ok: false,
        status: 401,
        body: null,
        text: async () => 'Unauthorized',
      }),
    ]);

    const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');
    await expect(synthesizeAudio('test', 'ep_api_error')).rejects.toThrow(/401/);
  });
});

// ── Integration test (live key required) ─────────────────────────────────────

const LIVE_KEY = process.env.ELEVENLABS_API_KEY &&
  !process.env.ELEVENLABS_API_KEY.startsWith('test-')
  ? process.env.ELEVENLABS_API_KEY
  : null;

describe.skipIf(!LIVE_KEY)(
  'synthesizeAudio — integration (live ElevenLabs API)',
  () => {
    // Restore real fetch for integration tests
    beforeAll(() => {
      globalThis.fetch = savedFetch;
      if (LIVE_KEY) process.env.ELEVENLABS_API_KEY = LIVE_KEY;
    });

    it(
      'synthesizes a short script, writes real MP3, duration 5-15 s',
      { timeout: 30_000 },
      async () => {
        const { synthesizeAudio } = await import('../src/pipeline/elevenlabs.js');

        const result = await synthesizeAudio(
          'Hello. This is a short test of the Sarah voice synthesis pipeline.',
          'ep_integration_test'
        );

        expect(result.audioPath).toBe('audio/ep_integration_test.mp3');
        expect(result.durationSec).toBeGreaterThan(1);
        expect(result.durationSec).toBeLessThan(15);

        const fullPath = path.join(testMediaDir, 'audio', 'ep_integration_test.mp3');
        expect(fs.existsSync(fullPath)).toBe(true);
        expect(fs.statSync(fullPath).size).toBeGreaterThan(1_000);
      }
    );
  }
);
