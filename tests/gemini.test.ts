/**
 * Tests for src/pipeline/gemini.ts
 *
 * Unit tests:  always run (mock fetch — no real API calls).
 * Integration: gated by GEMINI_API_KEY presence; skip cleanly in CI when unset.
 *
 * Fixtures: tests/fixtures/meals/meal_01.jpg + meal_02.jpg
 *   Programmatically-generated 16x16 JPEG placeholders (solid-colour stand-ins,
 *   not real food photos). Documented as fixtures for shape/API-call testing only.
 *
 * F4-E1 — Gemini vision+script stage unit + integration tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── DB wired to :memory: before any src/ import ─────────────────────────────
process.env.FOODPOD_DB_PATH = ':memory:';

// Temp media dir for test images
const testMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodpod-gemini-test-'));
process.env.FOODPOD_MEDIA_DIR = testMediaDir;

// Ensure images sub-dir exists in temp media dir
fs.mkdirSync(path.join(testMediaDir, 'images'), { recursive: true });

// ── Load module under test ───────────────────────────────────────────────────
import { runVisionAndScript } from '../src/pipeline/gemini.js';
import db from '../src/db.js';

// ── Fixture paths ────────────────────────────────────────────────────────────
const FIXTURE_DIR = path.join(import.meta.dirname ?? path.join(process.cwd(), 'tests'), 'fixtures', 'meals');
const FIXTURE_1 = path.join(FIXTURE_DIR, 'meal_01.jpg');
const FIXTURE_2 = path.join(FIXTURE_DIR, 'meal_02.jpg');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Seed the :memory: DB with a user + pod + N meal images pointing at fixture files.
 * Returns the podId.
 */
function seedPodWithImages(n: number): string {
  // Only clean up our own test rows — do NOT nuke the shared demo seed
  // (pod_demo_01 / usr_demo_01) which other test files depend on.
  db.run("DELETE FROM meal_images WHERE pod_id = 'pod_gemini_test'");
  db.run("DELETE FROM episodes WHERE pod_id = 'pod_gemini_test'");
  db.run("DELETE FROM pods WHERE id = 'pod_gemini_test'");
  // Only delete our test user if it was previously inserted by this function
  db.run("DELETE FROM users WHERE id = 'usr_gemini_test'");

  db.query(`
    INSERT OR IGNORE INTO users (id, email, name, profile, daily_targets)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run(
    'usr_gemini_test',
    'buzz@everbetter.com',
    'Buzz ONeil',
    JSON.stringify({ age: 35, weight_lbs: 175, goals: ['performance'] }),
    JSON.stringify({ calories: 2200, protein_g: 140, carbs_g: 220, fat_g: 70 })
  );

  db.query(`
    INSERT INTO pods (id, user_id, target_count, captured_count, status)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run('pod_gemini_test', 'usr_gemini_test', n, n, 'complete');

  for (let i = 1; i <= n; i++) {
    const imageId = `img_gemini_${String(i).padStart(2, '0')}`;
    // Alternate between the two fixture files
    const srcFixture = i % 2 === 1 ? FIXTURE_1 : FIXTURE_2;
    const destFilename = `${imageId}.jpg`;
    const destPath = path.join(testMediaDir, 'images', destFilename);

    // Copy fixture into temp media dir
    if (fs.existsSync(srcFixture)) {
      fs.copyFileSync(srcFixture, destPath);
    } else {
      // Fixture doesn't exist — write a minimal JPEG placeholder
      const TINY_JPEG = Buffer.from(
        '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDB' +
        'kSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAR' +
        'CAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA' +
        'AAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAA' +
        'AAAAAAAA/9oADAMBAAIRAxEAPwCwABmX/9k=',
        'base64'
      );
      fs.writeFileSync(destPath, TINY_JPEG);
    }

    db.query(
      'INSERT INTO meal_images (id, pod_id, sequence_number, image_path) VALUES (?1, ?2, ?3, ?4)'
    ).run(imageId, 'pod_gemini_test', i, path.join('images', destFilename));
  }

  return 'pod_gemini_test';
}

/** Build a valid mock Gemini API response body for the given result. */
function mockGeminiResponse(result: {
  title: string;
  summary: string;
  script: string;
  highlights: string[];
}): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(result) }],
        },
        finishReason: 'STOP',
      },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Unit tests — mock fetch, always run
// ────────────────────────────────────────────────────────────────────────────
describe('runVisionAndScript — unit (mocked fetch)', () => {
  const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key-mock';
  });

  afterAll(() => {
    if (ORIGINAL_KEY !== undefined) {
      process.env.GEMINI_API_KEY = ORIGINAL_KEY;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('throws if GEMINI_API_KEY is not set', async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(runVisionAndScript('pod_any')).rejects.toThrow('GEMINI_API_KEY is not set');
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it('throws if pod is not found', async () => {
    seedPodWithImages(0); // seeds DB tables but no pod with this ID
    db.run("DELETE FROM pods WHERE id = 'pod_gemini_test'");
    await expect(runVisionAndScript('pod_does_not_exist')).rejects.toThrow('pod not found');
  });

  it('throws if no meal images are found for the pod', async () => {
    seedPodWithImages(0); // pod exists but 0 images
    // Re-insert pod with 0 images
    db.run("DELETE FROM meal_images WHERE pod_id = 'pod_gemini_test'");
    await expect(runVisionAndScript('pod_gemini_test')).rejects.toThrow('no meal images found');
  });

  it('calls fetch with correct model, endpoint, and content parts', async () => {
    const podId = seedPodWithImages(2);

    const expectedResult = {
      title: 'Your Week in Nutrition',
      summary: 'A solid week overall with room to grow on fiber.',
      script: 'Hey Buzz! This week was great. You hit your protein targets most days...',
      highlights: ['Low fiber — add more leafy greens', 'Protein on point — keep it up'],
    };

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockGeminiResponse(expectedResult)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await runVisionAndScript(podId);

    // Verify fetch was called once
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify URL contains model name and key
    const [calledUrl, calledInit] = (mockFetch as Mock).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('gemini-2.5-flash');
    expect(calledUrl).toContain('generateContent');
    expect(calledUrl).toContain('test-key-mock');

    // Verify request body shape
    const body = JSON.parse(String(calledInit.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;
      generationConfig: {
        responseMimeType: string;
        responseSchema: Record<string, unknown>;
      };
    };

    // System instruction present
    expect(body.systemInstruction.parts[0].text).toMatch(/nutrition coach/i);

    // User content contains text prompt + 2 image parts
    const userParts = body.contents[0].parts;
    expect(body.contents[0].role).toBe('user');
    // First part is text prompt
    expect(typeof userParts[0].text).toBe('string');
    expect(String(userParts[0].text)).toContain('Daily targets');
    // Remaining parts are inlineData image parts
    const imageParts = userParts.slice(1);
    expect(imageParts).toHaveLength(2);
    for (const part of imageParts) {
      expect(part).toHaveProperty('inlineData');
      const inlineData = part.inlineData as { mimeType: string; data: string };
      expect(inlineData.mimeType).toBe('image/jpeg');
      expect(typeof inlineData.data).toBe('string');
      // Base64 string should be non-empty
      expect(inlineData.data.length).toBeGreaterThan(0);
    }

    // Response schema present and has required fields
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    const schema = body.generationConfig.responseSchema as {
      required: string[];
    };
    expect(schema.required).toContain('title');
    expect(schema.required).toContain('summary');
    expect(schema.required).toContain('script');
    expect(schema.required).toContain('highlights');

    // Verify return value
    expect(result.title).toBe(expectedResult.title);
    expect(result.summary).toBe(expectedResult.summary);
    expect(result.script).toBe(expectedResult.script);
    expect(result.highlights).toEqual(expectedResult.highlights);

    vi.restoreAllMocks();
  });

  it('includes ALL images as inlineData parts (7-image pod)', async () => {
    const podId = seedPodWithImages(7);

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          mockGeminiResponse({
            title: 'Week Recap',
            summary: 'Good week.',
            script: 'Hello Buzz, great week of eating!',
            highlights: ['More fiber needed'],
          })
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await runVisionAndScript(podId);

    const [, calledInit] = (mockFetch as Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(calledInit.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };

    const userParts = body.contents[0].parts;
    // 7 image parts + 1 text part
    expect(userParts).toHaveLength(8);
    const imageParts = userParts.slice(1);
    expect(imageParts).toHaveLength(7);

    vi.restoreAllMocks();
  });

  it('throws if API returns non-ok status', async () => {
    const podId = seedPodWithImages(1);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error": {"message": "API key invalid"}}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(runVisionAndScript(podId)).rejects.toThrow('HTTP 400');
    vi.restoreAllMocks();
  });

  it('throws if response has no candidates text', async () => {
    const podId = seedPodWithImages(1);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(runVisionAndScript(podId)).rejects.toThrow('no text in response');
    vi.restoreAllMocks();
  });

  it('throws if response JSON is missing required fields', async () => {
    const podId = seedPodWithImages(1);

    // Missing `script`
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ title: 'T', summary: 'S' }) }] } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(runVisionAndScript(podId)).rejects.toThrow('response missing field: script');
    vi.restoreAllMocks();
  });

  it('uses fallback string when profile JSON is malformed (does NOT throw)', async () => {
    const podId = seedPodWithImages(1);
    // Corrupt the profile JSON
    db.run(`UPDATE users SET profile = '{bad json' WHERE id = 'usr_gemini_test'`);

    const expectedResult = {
      title: 'Week Recap',
      summary: 'Good week.',
      script: 'Hello Buzz, great week of eating!',
      highlights: ['More fiber needed'],
    };

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockGeminiResponse(expectedResult)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // Should not throw despite malformed profile
    const result = await runVisionAndScript(podId);
    expect(result.title).toBe(expectedResult.title);

    // The prompt sent to Gemini should include the fallback string
    const [, calledInit] = (mockFetch as Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(calledInit.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const textPart = String((body.contents[0].parts[0] as { text: string }).text);
    expect(textPart).toContain('No profile available.');

    vi.restoreAllMocks();
  });

  it('uses fallback string when daily_targets JSON is malformed (does NOT throw)', async () => {
    const podId = seedPodWithImages(1);
    // Corrupt daily_targets JSON
    db.run(`UPDATE users SET daily_targets = '[truncated' WHERE id = 'usr_gemini_test'`);

    const expectedResult = {
      title: 'Targets Week',
      summary: 'Keep it up.',
      script: 'Hey Buzz, you are doing great!',
      highlights: ['Protein on point'],
    };

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockGeminiResponse(expectedResult)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // Should not throw despite malformed daily_targets
    const result = await runVisionAndScript(podId);
    expect(result.title).toBe(expectedResult.title);

    // The prompt should use the fallback
    const [, calledInit] = (mockFetch as Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(calledInit.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const textPart = String((body.contents[0].parts[0] as { text: string }).text);
    expect(textPart).toContain('No daily targets available.');

    vi.restoreAllMocks();
  });

  it('throws prefixed error with HTTP status when Gemini envelope is not valid JSON', async () => {
    const podId = seedPodWithImages(1);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    // Capture the promise once so both matchers exercise the same rejection
    const rejection = runVisionAndScript(podId);
    await expect(rejection).rejects.toThrow(/\[gemini\] envelope JSON malformed/);
    await expect(rejection).rejects.toThrow(/HTTP 200/);

    vi.restoreAllMocks();
  });

  it('returns empty highlights array when Gemini omits that field', async () => {
    const podId = seedPodWithImages(1);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'Episode',
                      summary: 'Summary here.',
                      script: 'Script text here for the podcast.',
                      // highlights intentionally omitted
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await runVisionAndScript(podId);
    expect(Array.isArray(result.highlights)).toBe(true);
    expect(result.highlights).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration test — real Gemini API call (skipped if no key)
// ────────────────────────────────────────────────────────────────────────────
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!HAS_KEY)('runVisionAndScript — integration (live Gemini API)', () => {
  // Note: this test makes a real API call to Gemini 1.5 Pro.
  // It is intentionally skipped in CI where GEMINI_API_KEY is not set.
  // Buzz sets the key on the VM for live testing.

  it('returns valid {title, summary, script, highlights[]} for 2 fixture images', async () => {
    const podId = seedPodWithImages(2);

    const result = await runVisionAndScript(podId);

    // Shape checks
    expect(typeof result.title).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);

    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);

    expect(typeof result.script).toBe('string');
    // Script should be between 200 and 1500 characters (60-180 sec spoken)
    expect(result.script.length).toBeGreaterThanOrEqual(200);
    expect(result.script.length).toBeLessThanOrEqual(1500);

    expect(Array.isArray(result.highlights)).toBe(true);
    // At least one highlight
    expect(result.highlights.length).toBeGreaterThan(0);
    for (const h of result.highlights) {
      expect(typeof h).toBe('string');
    }

    console.log('[integration] title:', result.title);
    console.log('[integration] highlights:', result.highlights);
    console.log('[integration] script length:', result.script.length, 'chars');
  }, 60_000); // 60s timeout for live API call
});
