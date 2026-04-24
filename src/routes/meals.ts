import { Hono } from 'hono';
import db from '../db.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const meals = new Hono();

/** Read at request time so test env overrides take effect. */
const getMediaDir = () => process.env.FOODPOD_MEDIA_DIR ?? path.join(process.cwd(), 'media');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * POST /api/pods/:id/images
 * Accept multipart/form-data with field 'image' (File / Blob).
 * Validates content-type (must start with image/) and size (<=10 MB).
 * Writes JPEG to <MEDIA_DIR>/images/<imageId>.jpg.
 * Inserts meal_images row and increments pods.captured_count.
 * Returns { imageId, sequenceNumber, capturedCount }.
 */
meals.post('/api/pods/:id/images', async (c) => {
  const podId = c.req.param('id');

  const pod = db.query(
    'SELECT id, captured_count, target_count FROM pods WHERE id = ?'
  ).get(podId) as {
    id: string;
    captured_count: number;
    target_count: number;
  } | undefined | null;

  if (!pod) {
    return c.json({ error: 'pod not found' }, 404);
  }

  // Parse multipart body
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid multipart body' }, 400);
  }

  const imageFile = formData.get('image');
  if (!imageFile || !(imageFile instanceof Blob)) {
    return c.json({ error: "missing 'image' field" }, 400);
  }

  // Validate content-type
  const contentType = imageFile.type || '';
  if (!contentType.startsWith('image/')) {
    return c.json({ error: 'unsupported media type — must be an image' }, 415);
  }

  // Validate size
  if (imageFile.size > MAX_FILE_SIZE) {
    return c.json({ error: 'file too large — max 10 MB' }, 413);
  }

  // Generate unique image ID
  const imageId = `img_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // Determine next sequence_number via SELECT MAX
  const seqRow = db.query(
    'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM meal_images WHERE pod_id = ?'
  ).get(podId) as { next_seq: number };
  const sequenceNumber = seqRow.next_seq;

  // Ensure images directory exists
  const MEDIA_DIR = getMediaDir();
  const imagesDir = path.join(MEDIA_DIR, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // Write file to disk
  const filename = `${imageId}.jpg`;
  const absPath = path.join(imagesDir, filename);
  const arrayBuffer = await imageFile.arrayBuffer();
  fs.writeFileSync(absPath, Buffer.from(arrayBuffer));

  // image_path stored as relative path from MEDIA_DIR (e.g. 'images/img_xxx.jpg')
  const relPath = path.join('images', filename);

  // Transactional: insert meal_images + increment captured_count
  const newCount = db.transaction(() => {
    db.query(
      'INSERT INTO meal_images (id, pod_id, sequence_number, image_path) VALUES (?1, ?2, ?3, ?4)'
    ).run(imageId, podId, sequenceNumber, relPath);

    const updatedCount = pod.captured_count + 1;
    db.query('UPDATE pods SET captured_count = ?1 WHERE id = ?2').run(updatedCount, podId);
    // NOTE: do NOT flip status here — only POST /complete triggers pipeline
    return updatedCount;
  })();

  return c.json({
    imageId,
    sequenceNumber,
    capturedCount: newCount,
  });
});

/**
 * GET /media/images/:filename
 * Serves image files from <MEDIA_DIR>/images/.
 * Supports HTTP Range requests (206 Partial Content) for audio/image seeking.
 * Returns 404 if not found, 200/206 with image/jpeg + Cache-Control + Accept-Ranges otherwise.
 */
meals.get('/media/images/:filename', (c) => {
  const filename = c.req.param('filename');

  // Basic path sanitisation — reject traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'invalid filename' }, 400);
  }

  const absPath = path.join(getMediaDir(), 'images', filename);

  if (!fs.existsSync(absPath)) {
    return c.json({ error: 'not found' }, 404);
  }

  const stat = fs.statSync(absPath);
  const totalSize = stat.size;
  const rangeHeader = c.req.header('Range');

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=604800, immutable',
    'Accept-Ranges': 'bytes',
  };

  // Handle byte-range request (for audio/image seeking)
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end   = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const clampedEnd = Math.min(end, totalSize - 1);

      if (start > clampedEnd || start >= totalSize) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` },
        });
      }

      const chunkSize = clampedEnd - start + 1;
      const fd = fs.openSync(absPath, 'r');
      const buf = Buffer.alloc(chunkSize);
      fs.readSync(fd, buf, 0, chunkSize, start);
      fs.closeSync(fd);

      return new Response(buf, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range':  `bytes ${start}-${clampedEnd}/${totalSize}`,
          'Content-Length': String(chunkSize),
        },
      });
    }
  }

  // Full response
  const data = fs.readFileSync(absPath);
  return new Response(data, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(totalSize) },
  });
});

/**
 * GET /media/audio/:filename
 * Serves MP3 audio files from <MEDIA_DIR>/audio/.
 * Supports HTTP Range requests (206 Partial Content) for audio seeking.
 * Returns 404 if not found, 200/206 with audio/mpeg + Cache-Control + Accept-Ranges otherwise.
 */
meals.get('/media/audio/:filename', (c) => {
  const filename = c.req.param('filename');

  // Basic path sanitisation — reject traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'invalid filename' }, 400);
  }

  const absPath = path.join(getMediaDir(), 'audio', filename);

  if (!fs.existsSync(absPath)) {
    return c.json({ error: 'not found' }, 404);
  }

  const stat = fs.statSync(absPath);
  const totalSize = stat.size;
  const rangeHeader = c.req.header('Range');

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'public, max-age=604800, immutable',
    'Accept-Ranges': 'bytes',
  };

  // Handle byte-range request (audio seeking)
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end   = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const clampedEnd = Math.min(end, totalSize - 1);

      if (start > clampedEnd || start >= totalSize) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` },
        });
      }

      const chunkSize = clampedEnd - start + 1;
      const fd = fs.openSync(absPath, 'r');
      const buf = Buffer.alloc(chunkSize);
      fs.readSync(fd, buf, 0, chunkSize, start);
      fs.closeSync(fd);

      return new Response(buf, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range':  `bytes ${start}-${clampedEnd}/${totalSize}`,
          'Content-Length': String(chunkSize),
        },
      });
    }
  }

  // Full response
  const data = fs.readFileSync(absPath);
  return new Response(data, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(totalSize) },
  });
});

export default meals;

