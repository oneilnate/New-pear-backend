/**
 * src/routes/dev.ts
 *
 * Dev-only routes — NOT mounted in production.
 * Guarded by X-Dev-Token header (checked against DEV_TOKEN env) OR
 * by NODE_ENV !== 'production' (whichever is configured).
 *
 * These routes exist solely for local dev and CI smoke-test resets.
 * They are never reachable on a live VM when NODE_ENV=production and
 * no DEV_TOKEN is set.
 */

import { Hono } from 'hono';
import db from '../db.js';

const dev = new Hono();

/**
 * Middleware: gate access to dev routes.
 *
 * Strategy:
 *  - If NODE_ENV === 'production' AND no DEV_TOKEN env var is set → 403.
 *  - If NODE_ENV === 'production' AND DEV_TOKEN is set → require
 *    matching X-Dev-Token header.
 *  - Otherwise (non-production) → allow freely.
 */
dev.use('*', async (c, next) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredToken = process.env.DEV_TOKEN ?? '';

  if (isProduction) {
    if (!configuredToken) {
      // Locked down: no dev token configured in production
      return c.json({ error: 'dev routes disabled in production' }, 403);
    }
    // Token-based gate
    const provided = c.req.header('X-Dev-Token') ?? '';
    if (provided !== configuredToken) {
      return c.json({ error: 'invalid or missing X-Dev-Token' }, 403);
    }
  }

  await next();
});

/**
 * POST /api/dev/reset-pod/:id
 *
 * Resets a pod to a clean "collecting" state:
 *   - Deletes all meal_images for the pod
 *   - Deletes all episodes for the pod
 *   - Resets pods.captured_count = 0, status = 'collecting'
 *
 * Returns: { ok: true, podId, deletedImages, deletedEpisodes }
 */
dev.post('/api/dev/reset-pod/:id', (c) => {
  const podId = c.req.param('id');

  const pod = db.query('SELECT id FROM pods WHERE id = ?').get(podId);
  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  // Run reset in a transaction
  const result = db.transaction(() => {
    const imagesInfo = db.query(
      'SELECT COUNT(*) AS count FROM meal_images WHERE pod_id = ?'
    ).get(podId) as { count: number };
    const episodesInfo = db.query(
      'SELECT COUNT(*) AS count FROM episodes WHERE pod_id = ?'
    ).get(podId) as { count: number };

    db.query('DELETE FROM meal_images WHERE pod_id = ?').run(podId);
    db.query('DELETE FROM episodes WHERE pod_id = ?').run(podId);
    db.query(
      "UPDATE pods SET captured_count = 0, status = 'collecting', failure_reason = NULL WHERE id = ?"
    ).run(podId);

    return {
      deletedImages: imagesInfo.count,
      deletedEpisodes: episodesInfo.count,
    };
  })();

  console.log(
    `[dev] reset-pod ${podId}: deleted ${result.deletedImages} images, ` +
    `${result.deletedEpisodes} episodes`
  );

  return c.json({
    ok: true,
    podId,
    deletedImages: result.deletedImages,
    deletedEpisodes: result.deletedEpisodes,
  });
});

export default dev;

