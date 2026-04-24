/**
 * Gemini 2.5 Pro vision+script pipeline stage.
 *
 * Single API call per pod — all meal images are attached as inlineData parts.
 * Returns structured JSON { title, summary, script, highlights[] } for the podcast.
 *
 * F4-E1 — implements the real stage in isolation.
 * F4-E3 will wire this into the pipeline orchestrator.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';

/** Shape returned by Gemini and surfaced to callers. */
export interface GeminiPodcastResult {
  title: string;
  summary: string;
  script: string;
  highlights: string[];
}

/** Gemini API base URL (v1beta for structured output / responseSchema support). */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-2.5-pro';

/** JSON schema sent as responseSchema so Gemini returns structured output. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Episode title, max 80 characters.' },
    summary: { type: 'string', description: 'One-paragraph plain-text summary for the episode card.' },
    script: { type: 'string', description: 'Full spoken script for Sarah voice TTS. 60-180 seconds when read aloud (~150-450 words).' },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      description: 'Top 2-3 specific nutrition insights or gaps identified (fiber, sugar, protein, etc.).',
    },
  },
  required: ['title', 'summary', 'script', 'highlights'],
};

/** System prompt: nutrition coach persona. */
const SYSTEM_PROMPT =
  'You are a warm, knowledgeable nutrition coach who creates personalized weekly podcast summaries. ' +
  'Your tone is encouraging, specific, and evidence-based. ' +
  'You identify concrete nutrition gaps (fiber, protein, sugar, micronutrients) and offer one actionable suggestion per gap. ' +
  'Scripts should feel natural when spoken aloud and run 60-180 seconds (roughly 150-450 words).';

/**
 * Run the Gemini 2.5 Pro vision+script stage for a given pod.
 *
 * Reads meal_images for the pod from the database, loads the image files from
 * disk, then calls Gemini with all images attached plus the user's profile and
 * daily targets for context.
 *
 * @param podId - The pod ID to generate a podcast script for.
 * @returns Structured { title, summary, script, highlights[] }.
 * @throws if GEMINI_API_KEY is not set, images cannot be read, or Gemini returns
 *   an invalid/incomplete response.
 */
export async function runVisionAndScript(podId: string): Promise<GeminiPodcastResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[gemini] GEMINI_API_KEY is not set — vision+script pipeline is disabled'
    );
  }

  // ── 1. Load pod + user profile ──────────────────────────────────────────────
  const podRow = db.query(`
    SELECT p.id, p.user_id,
           u.profile, u.daily_targets, u.name
    FROM pods p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).get(podId) as {
    id: string;
    user_id: string;
    profile: string | null;
    daily_targets: string | null;
    name: string;
  } | undefined | null;

  if (!podRow) {
    throw new Error(`[gemini] pod not found: ${podId}`);
  }

  const profile = podRow.profile
    ? JSON.stringify(JSON.parse(podRow.profile), null, 2)
    : 'No profile available.';
  const targets = podRow.daily_targets
    ? JSON.stringify(JSON.parse(podRow.daily_targets), null, 2)
    : 'No daily targets available.';

  // ── 2. Load meal images ─────────────────────────────────────────────────────
  const imageRows = db.query(`
    SELECT id, image_path, sequence_number
    FROM meal_images
    WHERE pod_id = ?
    ORDER BY sequence_number ASC
  `).all(podId) as Array<{
    id: string;
    image_path: string;
    sequence_number: number;
  }>;

  if (imageRows.length === 0) {
    throw new Error(`[gemini] no meal images found for pod ${podId}`);
  }

  const MEDIA_DIR = process.env.FOODPOD_MEDIA_DIR ?? path.join(process.cwd(), 'media');

  /** Build base64 inlineData parts for each image. */
  const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

  for (const row of imageRows) {
    const absPath = path.join(MEDIA_DIR, row.image_path);
    if (!fs.existsSync(absPath)) {
      console.warn(`[gemini] image file not found, skipping: ${absPath}`);
      continue;
    }
    const bytes = fs.readFileSync(absPath);
    imageParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: bytes.toString('base64'),
      },
    });
  }

  if (imageParts.length === 0) {
    throw new Error(`[gemini] all image files missing on disk for pod ${podId}`);
  }

  // ── 3. Build Gemini request ─────────────────────────────────────────────────
  const userPromptText =
    `User profile:\n${profile}\n\n` +
    `Daily targets:\n${targets}\n\n` +
    `Here are ${imageParts.length} meal photos from ${podRow.name}'s recent pod. ` +
    `Analyze the nutrition visible in the meals, identify the top 2-3 gaps versus the daily targets ` +
    `(prioritize fiber, sugar, and protein), and produce a warm, specific podcast script ` +
    `that the user will hear as a personalized audio summary.`;

  const requestBody = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: userPromptText },
          ...imageParts,
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  };

  // ── 4. Call Gemini API ──────────────────────────────────────────────────────
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `[gemini] API request failed: HTTP ${response.status} — ${errText.slice(0, 400)}`
    );
  }

  // ── 5. Parse + validate response ───────────────────────────────────────────
  const geminiResponse = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const textPart = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textPart) {
    throw new Error(
      `[gemini] no text in response: ${JSON.stringify(geminiResponse).slice(0, 400)}`
    );
  }

  let parsed: Partial<GeminiPodcastResult>;
  try {
    parsed = JSON.parse(textPart) as Partial<GeminiPodcastResult>;
  } catch {
    throw new Error(
      `[gemini] failed to parse JSON response: ${textPart.slice(0, 400)}`
    );
  }

  // Validate required fields
  if (!parsed.title) throw new Error('[gemini] response missing field: title');
  if (!parsed.summary) throw new Error('[gemini] response missing field: summary');
  if (!parsed.script) throw new Error('[gemini] response missing field: script');

  return {
    title: String(parsed.title),
    summary: String(parsed.summary),
    script: String(parsed.script),
    highlights: Array.isArray(parsed.highlights)
      ? parsed.highlights.map(String)
      : [],
  };
}
