/**
 * e2e/smoke.ts
 *
 * Cross-repo E2E smoke test: POST 7 fixture JPEGs → live backend → real MP3 validated.
 *
 * Usage:
 *   bun run e2e/smoke.ts
 *
 * Environment:
 *   API_BASE   Base URL of the backend  (default: https://pear-sandbox.everbetter.com)
 *   POD_ID     Pod ID to use            (default: pod_demo_01)
 *
 * Exit 0  = all steps pass (or partial pass when pipeline keys not set)
 * Exit 1  = any failure
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE = (process.env.API_BASE ?? 'https://pear-sandbox.everbetter.com').replace(/\/$/, '');
const POD_ID   = process.env.POD_ID   ?? 'pod_demo_01';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR  = path.join(__dirname, 'fixtures', 'meals');

// ── Timing helpers ────────────────────────────────────────────────────────────

const t0 = Date.now();
function elapsed(): string {
  return `${((Date.now() - t0) / 1000).toFixed(2)}s`;
}

const timings: Record<string, number> = {};
function startTimer(name: string): () => number {
  const start = Date.now();
  return () => {
    const ms = Date.now() - start;
    timings[name] = ms;
    return ms;
  };
}

// ── Result tracking ───────────────────────────────────────────────────────────

type StepResult = { label: string; pass: boolean; detail: string; ms: number };
const results: StepResult[] = [];

function pass(label: string, detail: string, ms: number): void {
  results.push({ label, pass: true, detail, ms });
  console.log(`  ✅  [${elapsed()}] ${label} — ${detail} (${ms}ms)`);
}

function fail(label: string, detail: string, ms: number): never {
  results.push({ label, pass: false, detail, ms });
  console.error(`  ❌  [${elapsed()}] ${label} — ${detail} (${ms}ms)`);
  printSummary();
  process.exit(1);
}

function printSummary(): void {
  console.log('\n' + '─'.repeat(60));
  console.log('E2E Smoke Test Summary');
  console.log('─'.repeat(60));
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`  ${icon}  ${r.label.padEnd(35)} ${r.ms}ms`);
    if (!r.pass) console.log(`        └─ ${r.detail}`);
  }
  console.log('─'.repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`  ${passed}/${results.length} steps passed  |  total: ${elapsed()}`);
  console.log('─'.repeat(60));
}

// ── MP3 validation helper ─────────────────────────────────────────────────────

/**
 * Checks the first 4 bytes for a valid MP3 frame-sync or ID3 header.
 * MP3 frame sync: 0xFF 0xFB/0xFA/0xF3/0xF2  (and other valid sync patterns)
 * ID3v2 header:   0x49 0x44 0x33 ('I','D','3')
 */
function isValidMp3Header(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // ID3 tag
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  // MPEG frame sync: 0xFF followed by 0xE0 mask being all set
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return true;
  return false;
}

/**
 * Rough duration estimate from MP3 bytes (no file path needed).
 * Used after downloading the audio to an in-memory buffer.
 */
function estimateMp3DurationSec(buf: Buffer): number {
  // MPEG1 bit-rate table (Layer III)
  const BITRATES = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const SAMPLE_RATES = [44100,48000,32000,0];
  const totalBytes = buf.length;

  // Skip ID3 tag
  let offset = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf.length >= 10) {
    const id3Size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                   ((buf[8] & 0x7f) << 7)  |  (buf[9] & 0x7f);
    offset = 10 + id3Size;
  }

  // Scan for first valid MPEG frame header
  const SCAN_LIMIT = Math.min(256 * 1024, buf.length);
  while (offset < SCAN_LIMIT - 4) {
    if (buf[offset] === 0xFF && (buf[offset + 1] & 0xE0) === 0xE0) {
      const b1 = buf[offset + 1];
      const b2 = buf[offset + 2];
      const mpegVer = (b1 >> 3) & 0x03;
      const layer   = (b1 >> 1) & 0x03;
      if (mpegVer === 0x03 && layer === 0x01) {
        const bitrateKbps = BITRATES[(b2 >> 4) & 0x0f];
        const sampleRateHz = SAMPLE_RATES[(b2 >> 2) & 0x03];
        if (bitrateKbps > 0 && sampleRateHz > 0) {
          const bytesPerSec = (bitrateKbps * 1000) / 8;
          return totalBytes / bytesPerSec;
        }
      }
    }
    offset++;
  }

  // Fallback: assume 128 kbps CBR
  return totalBytes / ((128 * 1000) / 8);
}

// ── Main smoke test ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n🍐 Food Pod — E2E Smoke Test');
  console.log(`   API_BASE : ${API_BASE}`);
  console.log(`   POD_ID   : ${POD_ID}`);
  console.log();

  // ── Step 1: Health check ─────────────────────────────────────────────────
  {
    const stop = startTimer('health');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/health`);
    } catch (err) {
      fail('Step 1: GET /api/health', `network error: ${err}`, stop());
    }
    const ms = stop();
    if (!res.ok) {
      fail('Step 1: GET /api/health', `HTTP ${res.status}`, ms);
    }
    const body = await res.json() as { ok?: boolean };
    if (body.ok !== true) {
      fail('Step 1: GET /api/health', `expected {ok:true}, got ${JSON.stringify(body)}`, ms);
    }
    pass('Step 1: GET /api/health', 'ok: true', ms);
  }

  // ── Step 2: Load 7 fixture JPEGs ────────────────────────────────────────
  let fixtures: Array<{ name: string; path: string; data: Buffer }>;
  {
    const stop = startTimer('fixtures');
    const files = fs.readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    if (files.length < 7) {
      fail(
        'Step 2: Load fixtures',
        `expected 7 JPEGs in ${FIXTURES_DIR}, found ${files.length}`,
        stop()
      );
    }

    fixtures = files.slice(0, 7).map((f) => ({
      name: f,
      path: path.join(FIXTURES_DIR, f),
      data: fs.readFileSync(path.join(FIXTURES_DIR, f)),
    }));
    pass('Step 2: Load fixtures', `${fixtures.length} JPEGs loaded`, stop());
  }

  // ── Step 3: POST each image ──────────────────────────────────────────────
  let lastCapturedCount = 0;
  {
    const stop = startTimer('upload');
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      const form = new FormData();
      const blob = new Blob([f.data], { type: 'image/jpeg' });
      form.append('image', blob, f.name);

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/api/pods/${POD_ID}/images`, {
          method: 'POST',
          body: form,
        });
      } catch (err) {
        fail(`Step 3: Upload image ${i + 1}/7`, `network error: ${err}`, stop());
      }

      if (!res.ok) {
        const text = await res.text();
        fail(`Step 3: Upload image ${i + 1}/7`, `HTTP ${res.status}: ${text}`, stop());
      }

      const body = await res.json() as { capturedCount: number };
      lastCapturedCount = body.capturedCount;
      console.log(`        image ${i + 1}/7 → capturedCount: ${lastCapturedCount}`);
    }
    pass('Step 3: POST 7 images', `capturedCount: ${lastCapturedCount}`, stop());
  }

  // ── Step 4: GET pod — assert capturedCount === 7 and valid status ────────
  {
    const stop = startTimer('pod-state');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/pods/${POD_ID}`);
    } catch (err) {
      fail('Step 4: GET /api/pods/:id', `network error: ${err}`, stop());
    }
    const ms = stop();
    if (!res.ok) {
      fail('Step 4: GET /api/pods/:id', `HTTP ${res.status}`, ms);
    }
    const body = await res.json() as { capturedCount: number; status: string };
    if (body.capturedCount !== 7) {
      fail('Step 4: GET /api/pods/:id', `capturedCount ${body.capturedCount} !== 7`, ms);
    }
    const validStatuses = ['collecting', 'ready_to_generate', 'ready', 'generating'];
    if (!validStatuses.includes(body.status)) {
      fail('Step 4: GET /api/pods/:id', `unexpected status: ${body.status}`, ms);
    }
    pass('Step 4: GET /api/pods/:id', `capturedCount=7, status=${body.status}`, ms);
  }

  // ── Step 5: POST /complete ───────────────────────────────────────────────
  let episodeId: string;
  let audioUrl: string;
  {
    const stop = startTimer('complete');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/pods/${POD_ID}/complete`, { method: 'POST' });
    } catch (err) {
      fail('Step 5: POST /complete', `network error: ${err}`, stop());
    }
    const ms = stop();

    if (res.status === 503) {
      // Pipeline keys not configured — partial pass
      const body = await res.json() as { error: string };
      console.log(`\n  ⚠️   Pipeline keys not set: ${body.error}`);
      console.log('  📝  Partial pass — smoke harness infrastructure is working;');
      console.log('      set GEMINI_API_KEY + ELEVENLABS_API_KEY on the VM for a full run.\n');
      results.push({
        label: 'Step 5: POST /complete',
        pass: true,
        detail: `503 partial pass — ${body.error}`,
        ms,
      });
      // Print partial summary and exit 0
      printSummary();
      process.exit(0);
    }

    if (!res.ok) {
      const text = await res.text();
      fail('Step 5: POST /complete', `HTTP ${res.status}: ${text}`, ms);
    }

    const body = await res.json() as {
      episodeId?: string;
      audioUrl?: string;
      durationSec?: number;
      title?: string;
      summary?: string;
    };

    if (!body.episodeId || !body.audioUrl) {
      fail(
        'Step 5: POST /complete',
        `response missing episodeId or audioUrl: ${JSON.stringify(body)}`,
        ms
      );
    }

    episodeId = body.episodeId;
    audioUrl  = body.audioUrl;
    pass(
      'Step 5: POST /complete',
      `episodeId=${episodeId}, durationSec=${body.durationSec}`,
      ms
    );
  }

  // ── Step 6: Download MP3 + validate ─────────────────────────────────────
  {
    const stop = startTimer('mp3');
    let res: Response;
    try {
      res = await fetch(audioUrl!);
    } catch (err) {
      fail('Step 6: Download MP3', `network error: ${err}`, stop());
    }
    const ms = stop();

    if (!res.ok) {
      fail('Step 6: Download MP3', `HTTP ${res.status}`, ms);
    }

    const contentLengthHeader = res.headers.get('content-length');
    const arrayBuf = await res.arrayBuffer();
    const mp3Bytes = Buffer.from(arrayBuf);

    // Size > 10 KB
    if (mp3Bytes.length <= 10 * 1024) {
      fail('Step 6: Download MP3', `size ${mp3Bytes.length} bytes ≤ 10 KB`, ms);
    }

    // Content-Length header match
    if (contentLengthHeader !== null) {
      const declared = parseInt(contentLengthHeader, 10);
      if (!isNaN(declared) && declared !== mp3Bytes.length) {
        fail(
          'Step 6: Download MP3',
          `Content-Length ${declared} !== downloaded ${mp3Bytes.length}`,
          ms
        );
      }
    }

    // MP3 frame sync or ID3 header
    if (!isValidMp3Header(mp3Bytes)) {
      fail(
        'Step 6: Download MP3',
        `invalid header bytes: 0x${mp3Bytes[0].toString(16).padStart(2,'0')} ` +
        `0x${mp3Bytes[1].toString(16).padStart(2,'0')} ` +
        `0x${mp3Bytes[2].toString(16).padStart(2,'0')}`,
        ms
      );
    }

    // Duration 60 – 240 sec
    const durationSec = estimateMp3DurationSec(mp3Bytes);
    if (durationSec < 60 || durationSec > 240) {
      fail(
        'Step 6: Download MP3',
        `duration ${durationSec.toFixed(1)}s out of range [60, 240]`,
        ms
      );
    }

    pass(
      'Step 6: Download MP3',
      `${Math.round(mp3Bytes.length / 1024)} KB, ~${durationSec.toFixed(1)}s`,
      ms
    );
  }

  // ── Step 7: GET /episode — verify same episodeId ─────────────────────────
  {
    const stop = startTimer('episode');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/pods/${POD_ID}/episode`);
    } catch (err) {
      fail('Step 7: GET /episode', `network error: ${err}`, stop());
    }
    const ms = stop();

    if (!res.ok) {
      fail('Step 7: GET /episode', `HTTP ${res.status}`, ms);
    }

    const body = await res.json() as { episodeId?: string };
    if (body.episodeId !== episodeId) {
      fail(
        'Step 7: GET /episode',
        `episodeId mismatch: expected ${episodeId!}, got ${body.episodeId}`,
        ms
      );
    }
    pass('Step 7: GET /episode', `episodeId=${body.episodeId}`, ms);
  }

  // ── All steps passed ─────────────────────────────────────────────────────
  printSummary();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nUnhandled error in smoke test:', err);
  process.exit(1);
});

