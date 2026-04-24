import { Hono } from 'hono';
import db from '../db.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const meals = new Hono();

const MEDIA_DIR = process.env.FOODPOD_MEDIA_DIR ?? path.join(process.cwd(), 'media');

// POST /api/pods/:id/images  — stub in F2-E1, real multipart upload in F2-E2
meals.post('/api/pods/:id/images', async (c) => {
  const podId = c.req.param('id');

  const pod = db.query('SELECT id, captured_count FROM pods WHERE id = ?').get(podId) as {
    id: string;
    captured_count: number;
  } | undefined | null;

  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  // Stub: create a placeholder image record (real multipart upload in F2-E2)
  const imageId = `img_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const sequenceNumber = pod.captured_count + 1;
  const imagesDir = path.join(MEDIA_DIR, 'images');

  // Ensure media dir exists for local dev; in prod /srv/foodpod/media is premounted
  try {
    fs.mkdirSync(imagesDir, { recursive: true });
  } catch {
    // ignore
  }

  const imagePath = path.join(imagesDir, `${imageId}.jpg`);

  db.query(`
    INSERT INTO meal_images (id, pod_id, sequence_number, image_path)
    VALUES (?1, ?2, ?3, ?4)
  `).run(imageId, podId, sequenceNumber, imagePath);

  const newCount = sequenceNumber;
  db.query('UPDATE pods SET captured_count = ?1 WHERE id = ?2').run(newCount, podId);

  return c.json({
    imageId,
    sequenceNumber,
    capturedCount: newCount,
  });
});

export default meals;
