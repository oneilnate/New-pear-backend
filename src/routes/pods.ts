import { Hono } from 'hono';
import db from '../db.js';
import path from 'path';
import fs from 'fs';
import { runPipeline, PodNotReadyError } from '../pipeline/run.js';

const pods = new Hono();

/** Base URL for audio files, derived from the request Host at runtime. */
function audioUrl(baseUrl: string, episodeId: string): string {
  return `${baseUrl}/media/audio/${episodeId}.mp3`;
}

/** Derive the request base URL (scheme://host) from a Hono context. */
function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

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

