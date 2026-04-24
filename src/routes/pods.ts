import { Hono } from 'hono';
import db from '../db.js';
import path from 'path';
import { runPipeline } from '../pipeline/run.js';

const pods = new Hono();

// GET /api/pods/:id
pods.get('/api/pods/:id', (c) => {
  const id = c.req.param('id');

  const pod = db.query(`
    SELECT id, status, target_count, captured_count, created_at, ready_at
    FROM pods WHERE id = ?
  `).get(id) as {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
    created_at: string;
    ready_at: string | null;
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

  const episodeRow = db.query(`
    SELECT id, title, summary_text, audio_path, duration_sec, created_at
    FROM episodes WHERE pod_id = ? LIMIT 1
  `).get(id) as {
    id: string;
    title: string | null;
    summary_text: string | null;
    audio_path: string | null;
    duration_sec: number | null;
    created_at: string;
  } | undefined | null;

  const episode = episodeRow ? {
    id: episodeRow.id,
    title: episodeRow.title,
    summaryText: episodeRow.summary_text,
    audioPath: episodeRow.audio_path,
    durationSec: episodeRow.duration_sec,
    createdAt: episodeRow.created_at,
  } : null;

  return c.json({
    id: pod.id,
    status: pod.status,
    targetCount: pod.target_count,
    capturedCount: pod.captured_count,
    recentSnaps,
    episode,
  });
});

// POST /api/pods/:id/complete
pods.post('/api/pods/:id/complete', async (c) => {
  // Guard: pipeline requires GEMINI_API_KEY (and will require ELEVENLABS_API_KEY in F4-E2).
  // Return 503 with a clear message rather than crashing or silently failing.
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[complete] 503 — pipeline disabled: GEMINI_API_KEY is not set');
    return c.json({ error: 'pipeline disabled — missing credentials' }, 503);
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

  db.query(`UPDATE pods SET status = 'generating' WHERE id = ?`).run(id);

  // Fire pipeline (stubbed in F2-E1)
  runPipeline(id);

  return c.json({ status: 'generating' });
});

// GET /api/pods/:id/episode
pods.get('/api/pods/:id/episode', (c) => {
  const id = c.req.param('id');

  const pod = db.query('SELECT id FROM pods WHERE id = ?').get(id);
  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  const episode = db.query(`
    SELECT id, title, summary_text, script_text, audio_path, duration_sec, created_at
    FROM episodes WHERE pod_id = ? LIMIT 1
  `).get(id) as {
    id: string;
    title: string | null;
    summary_text: string | null;
    script_text: string | null;
    audio_path: string | null;
    duration_sec: number | null;
    created_at: string;
  } | undefined | null;

  if (!episode) {
    return c.json({ error: 'episode not ready' }, 404);
  }

  return c.json({
    id: episode.id,
    title: episode.title,
    summaryText: episode.summary_text,
    scriptText: episode.script_text,
    audioPath: episode.audio_path,
    durationSec: episode.duration_sec,
    createdAt: episode.created_at,
  });
});

export default pods;
