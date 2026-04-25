import { Hono } from 'hono';
import type { Context } from 'hono';
import crypto from 'crypto';
import db from '../db.js';
import path from 'path';
import fs from 'fs';
import { runPipeline, PodNotReadyError } from '../pipeline/run.js';

const pods = new Hono();

/** Base URL for audio files, derived from the request Host at runtime. */
function audioUrl(baseUrl: string, episodeId: string): string {
  return `${baseUrl}/media/audio/${episodeId}.mp3`;
}

/** Derive the request base URL (scheme://host) from a Hono context.
 *
 * When the server is behind a TLS-terminating reverse proxy (nginx), the raw
 * request URL will have an http:// scheme even though clients connected over
 * HTTPS.  nginx (and other proxies) set X-Forwarded-Proto / X-Forwarded-Host
 * headers so the application can reconstruct the public-facing URL.  We prefer
 * those headers when present; otherwise we fall back to the URL parsed from the
 * raw request (useful for local development with no proxy).
 */
function getBaseUrl(c: Context): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header('x-forwarded-proto');
  const forwardedHost = c.req.header('x-forwarded-host');
  const protocol = forwardedProto ? `${forwardedProto}:` : url.protocol;
  const host = forwardedHost ?? url.host;
  return `${protocol}//${host}`;
}

/** Default target meal count for a new pod. */
const DEFAULT_TARGET_COUNT = 7;

/** Demo user ID (single-user demo mode). */
const DEMO_USER_ID = 'usr_demo_01';

// ─── Helper: build the full pod response shape (reused by /current and /:id) ───

function buildPodResponse(
  pod: {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
    created_at: string;
    ready_at: string | null;
    failure_reason: string | null;
  },
  c: Context
): Record<string, unknown> {
  const snaps = db.query(`
    SELECT id, image_path, rating FROM meal_images WHERE pod_id = ? ORDER BY sequence_number DESC LIMIT 5
  `).all(pod.id) as Array<{ id: string; image_path: string; rating: string | null }>;

  const recentSnaps = snaps.map((s) => ({
    id: s.id,
    thumb: `/media/images/${path.basename(s.image_path)}`,
    rating: s.rating,
  }));

  let episode: object | null = null;
  if (pod.status === 'ready') {
    const episodeRow = db.query(`
      SELECT id, title, summary_text, audio_path, duration_sec, highlights, created_at
      FROM episodes WHERE pod_id = ? LIMIT 1
    `).get(pod.id) as {
      id: string;
      title: string | null;
      summary_text: string | null;
      audio_path: string | null;
      duration_sec: number | null;
      highlights: string | null;
      created_at: string;
    } | undefined | null;

    if (episodeRow) {
      const baseUrl = getBaseUrl(c);
      episode = {
        episodeId: episodeRow.id,
        audioUrl: episodeRow.audio_path
          ? audioUrl(baseUrl, episodeRow.id)
          : null,
        durationSec: episodeRow.duration_sec,
        title: episodeRow.title,
        summary: episodeRow.summary_text,
        highlights: episodeRow.highlights
          ? (JSON.parse(episodeRow.highlights) as string[])
          : [],
        createdAt: episodeRow.created_at,
      };
    }
  }

  return {
    id: pod.id,
    status: pod.status,
    targetCount: pod.target_count,
    capturedCount: pod.captured_count,
    recentSnaps,
    episode,
    ...(pod.failure_reason ? { failureReason: pod.failure_reason } : {}),
  };
}

// ─── GET /api/pods/current ──────────────────────────────────────────────────
//
// Returns the newest pod for the demo user, ordered by created_at DESC.
// If the user has no pod, auto-creates one with default target_count=7.
// Never returns 404.

pods.get('/api/pods/current', (c) => {
  const userId = DEMO_USER_ID;

  let pod = db.query(`
    SELECT id, status, target_count, captured_count, created_at, ready_at, failure_reason
    FROM pods WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(userId) as {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
    created_at: string;
    ready_at: string | null;
    failure_reason: string | null;
  } | undefined | null;

  if (!pod) {
    // Auto-create a new pod for the user
    const newPodId = `pod_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    db.query(`
      INSERT INTO pods (id, user_id, target_count, captured_count, status)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).run(newPodId, userId, DEFAULT_TARGET_COUNT, 0, 'collecting');

    pod = db.query(`
      SELECT id, status, target_count, captured_count, created_at, ready_at, failure_reason
      FROM pods WHERE id = ?
    `).get(newPodId) as {
      id: string;
      status: string;
      target_count: number;
      captured_count: number;
      created_at: string;
      ready_at: string | null;
      failure_reason: string | null;
    };
  }

  return c.json(buildPodResponse(pod, c));
});

// ─── GET /api/pods ──────────────────────────────────────────────────────────
//
// Returns array of all pods for the demo user, newest-first.
// Minimal shape: id, created_at, status, captured_count, target_count.

pods.get('/api/pods', (c) => {
  const userId = DEMO_USER_ID;

  const allPods = db.query(`
    SELECT id, status, target_count, captured_count, created_at
    FROM pods WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId) as Array<{
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
    created_at: string;
  }>;

  return c.json(allPods.map((p) => ({
    id: p.id,
    status: p.status,
    targetCount: p.target_count,
    capturedCount: p.captured_count,
    createdAt: p.created_at,
  })));
});

// ─── POST /api/pods ─────────────────────────────────────────────────────────
//
// Creates a new pod for the demo user with default target_count=7.
// Returns the new pod in the standard Pod response shape.

pods.post('/api/pods', (c) => {
  const userId = DEMO_USER_ID;

  const newPodId = `pod_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  db.query(`
    INSERT INTO pods (id, user_id, target_count, captured_count, status)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run(newPodId, userId, DEFAULT_TARGET_COUNT, 0, 'collecting');

  const pod = db.query(`
    SELECT id, status, target_count, captured_count, created_at, ready_at, failure_reason
    FROM pods WHERE id = ?
  `).get(newPodId) as {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
    created_at: string;
    ready_at: string | null;
    failure_reason: string | null;
  };

  return c.json(buildPodResponse(pod, c), 201);
});

// GET /api/pods/:id
pods.get('/api/pods/:id', (c) => {
  const id = c.req.param('id');

  const pod = db.query(`
    SELECT id, status, target_count, captured_count, created_at, ready_at, failure_reason
    FROM pods WHERE id = ?
  `).get(id) as {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
    created_at: string;
    ready_at: string | null;
    failure_reason: string | null;
  } | undefined | null;

  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  const snaps = db.query(`
    SELECT id, image_path, rating FROM meal_images WHERE pod_id = ? ORDER BY sequence_number DESC LIMIT 5
  `).all(id) as Array<{ id: string; image_path: string; rating: string | null }>;

  const recentSnaps = snaps.map((s) => ({
    id: s.id,
    thumb: `/media/images/${path.basename(s.image_path)}`,
    rating: s.rating,
  }));

  // Include episode only when pod is ready
  let episode: object | null = null;
  if (pod.status === 'ready') {
    const episodeRow = db.query(`
      SELECT id, title, summary_text, audio_path, duration_sec, highlights, created_at
      FROM episodes WHERE pod_id = ? LIMIT 1
    `).get(id) as {
      id: string;
      title: string | null;
      summary_text: string | null;
      audio_path: string | null;
      duration_sec: number | null;
      highlights: string | null;
      created_at: string;
    } | undefined | null;

    if (episodeRow) {
      const baseUrl = getBaseUrl(c);
      episode = {
        episodeId: episodeRow.id,
        audioUrl: episodeRow.audio_path
          ? audioUrl(baseUrl, episodeRow.id)
          : null,
        durationSec: episodeRow.duration_sec,
        title: episodeRow.title,
        summary: episodeRow.summary_text,
        highlights: episodeRow.highlights
          ? (JSON.parse(episodeRow.highlights) as string[])
          : [],
        createdAt: episodeRow.created_at,
      };
    }
  }

  return c.json({
    id: pod.id,
    status: pod.status,
    targetCount: pod.target_count,
    capturedCount: pod.captured_count,
    recentSnaps,
    episode,
    ...(pod.failure_reason ? { failureReason: pod.failure_reason } : {}),
  });
});

// POST /api/pods/:id/complete
pods.post('/api/pods/:id/complete', async (c) => {
  // Guard: return 503 if either pipeline key is missing
  const missingKeys: string[] = [];
  if (!process.env.GEMINI_API_KEY) missingKeys.push('GEMINI_API_KEY');
  if (!process.env.ELEVENLABS_API_KEY) missingKeys.push('ELEVENLABS_API_KEY');
  if (missingKeys.length > 0) {
    const msg = `pipeline disabled — missing credentials: ${missingKeys.join(', ')}`;
    console.warn(`[complete] 503 — ${msg}`);
    return c.json({ error: msg }, 503);
  }

  const id = c.req.param('id');

  const pod = db.query('SELECT id, status, target_count, captured_count FROM pods WHERE id = ?').get(id) as {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
  } | undefined | null;

  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  if (pod.captured_count < pod.target_count) {
    return c.json(
      {
        error: 'not enough meals',
        needed: pod.target_count,
        captured: pod.captured_count,
      },
      400
    );
  }

  // Run pipeline inline (awaited — no queue, no worker)
  try {
    const result = await runPipeline(id);
    const baseUrl = getBaseUrl(c);
    return c.json({
      episodeId: result.episodeId,
      audioUrl: audioUrl(baseUrl, result.episodeId),
      durationSec: result.durationSec,
      title: result.title,
      summary: result.summary,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // MISSING_CREDENTIALS: 503
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'MISSING_CREDENTIALS'
    ) {
      return c.json({ error: message }, 503);
    }

    // PodNotReadyError: 400 (shouldn't normally reach here since we checked above, but handle defensively)
    if (err instanceof PodNotReadyError) {
      return c.json({ error: 'not enough meals' }, 400);
    }

    // All other pipeline errors: 500
    console.error(`[complete] pod=${id} pipeline error: ${message}`);
    return c.json({ error: message }, 500);
  }
});

// GET /api/pods/:id/episode
pods.get('/api/pods/:id/episode', (c) => {
  const id = c.req.param('id');

  const pod = db.query('SELECT id FROM pods WHERE id = ?').get(id);
  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  const episode = db.query(`
    SELECT id, title, summary_text, script_text, audio_path, duration_sec, highlights, created_at
    FROM episodes WHERE pod_id = ? LIMIT 1
  `).get(id) as {
    id: string;
    title: string | null;
    summary_text: string | null;
    script_text: string | null;
    audio_path: string | null;
    duration_sec: number | null;
    highlights: string | null;
    created_at: string;
  } | undefined | null;

  if (!episode) {
    return c.json({ error: 'NO_EPISODE' }, 404);
  }

  const baseUrl = getBaseUrl(c);
  return c.json({
    episodeId: episode.id,
    audioUrl: episode.audio_path ? audioUrl(baseUrl, episode.id) : null,
    durationSec: episode.duration_sec,
    title: episode.title,
    summary: episode.summary_text,
    highlights: episode.highlights
      ? (JSON.parse(episode.highlights) as string[])
      : [],
    createdAt: episode.created_at,
  });
});

// GET /media/audio/:filename
// Serves MP3 files from <MEDIA_DIR>/audio/.
pods.get('/media/audio/:filename', (c) => {
  const filename = c.req.param('filename');

  // Basic path sanitisation
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'invalid filename' }, 400);
  }

  const mediaDir = process.env.FOODPOD_MEDIA_DIR ?? path.join(process.cwd(), 'media');
  const absPath = path.join(mediaDir, 'audio', filename);

  if (!fs.existsSync(absPath)) {
    return c.json({ error: 'not found' }, 404);
  }

  const data = fs.readFileSync(absPath);
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

export default pods;

