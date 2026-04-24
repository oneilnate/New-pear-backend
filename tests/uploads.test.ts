import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// MUST be set before any src/ import so db.ts opens :memory:
process.env.FOODPOD_DB_PATH = ':memory:';

// Use a temp directory for media storage during tests
const testMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodpod-test-'));
process.env.FOODPOD_MEDIA_DIR = testMediaDir;

import { app } from '../src/server.js';

// Minimal 1x1 JPEG bytes (valid JPEG)
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
  'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA' +
  'AAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA' +
  '/9oADAMBAAIRAxEAPwCwABmX/9k=',
  'base64'
);

function makeImageFormData(blob: Blob): FormData {
  const fd = new FormData();
  fd.append('image', blob, 'meal.jpg');
  return fd;
}

function makeTinyJpegBlob(): Blob {
  return new Blob([TINY_JPEG], { type: 'image/jpeg' });
}

function makeTextBlob(): Blob {
  // Use a non-image MIME type; filename must NOT end with an image extension
  // because some runtimes infer content-type from filename extension.
  return new Blob(['hello'], { type: 'text/plain' });
}

function textBlobFormData(): FormData {
  const fd = new FormData();
  // Append with a .txt filename so Bun won't infer image/jpeg from extension
  fd.append('image', new Blob(['hello'], { type: 'text/plain' }), 'meal.txt');
  return fd;
}

function makeLargeJpegBlob(): Blob {
  // 11 MB buffer — over the 10 MB limit
  const buf = Buffer.alloc(11 * 1024 * 1024, 0xff);
  return new Blob([buf], { type: 'image/jpeg' });
}

async function postImage(podId: string, blob: Blob) {
  const fd = makeImageFormData(blob);
  return app.fetch(
    new Request(`http://localhost/api/pods/${podId}/images`, {
      method: 'POST',
      body: fd,
    })
  );
}

/**
 * Reset meal_images + captured_count at the start of this file.
 * Bun's test runner may share the module singleton (and its :memory: DB)
 * across test files in the same process, so we need an explicit reset.
 */
beforeAll(async () => {
  // Lazily import db here to avoid a circular import at module scope
  const { default: db } = await import('../src/db.js');
  db.run('DELETE FROM meal_images');
  db.run("UPDATE pods SET captured_count = 0 WHERE id = 'pod_demo_01'");
});

afterAll(() => {
  // Clean up temp media dir
  fs.rmSync(testMediaDir, { recursive: true, force: true });
});

describe('POST /api/pods/:id/images — real upload handler', () => {
  it('returns 200 with correct shape and increments captured_count', async () => {
    const res = await postImage('pod_demo_01', makeTinyJpegBlob());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      imageId: string;
      sequenceNumber: number;
      capturedCount: number;
    };
    expect(body.imageId).toMatch(/^img_[a-f0-9]{12}$/);
    expect(body.sequenceNumber).toBe(1);
    expect(body.capturedCount).toBe(1);
  });

  it('increments captured_count on subsequent uploads', async () => {
    const res = await postImage('pod_demo_01', makeTinyJpegBlob());
    expect(res.status).toBe(200);
    const body = await res.json() as { capturedCount: number; sequenceNumber: number };
    expect(body.sequenceNumber).toBe(2);
    expect(body.capturedCount).toBe(2);
  });

  it('returns 415 for non-image content-type', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01/images', {
        method: 'POST',
        body: textBlobFormData(),
      })
    );
    expect(res.status).toBe(415);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/unsupported media type/i);
  });

  it('returns 413 for files over 10 MB', async () => {
    const res = await postImage('pod_demo_01', makeLargeJpegBlob());
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('returns 404 for unknown pod', async () => {
    const res = await postImage('pod_unknown', makeTinyJpegBlob());
    expect(res.status).toBe(404);
  });

  it('7th upload has capturedCount=7', async () => {
    // 2 already uploaded above; need 5 more to reach 7
    for (let i = 0; i < 4; i++) {
      await postImage('pod_demo_01', makeTinyJpegBlob());
    }
    const res = await postImage('pod_demo_01', makeTinyJpegBlob());
    expect(res.status).toBe(200);
    const body = await res.json() as { capturedCount: number };
    expect(body.capturedCount).toBe(7);
  });

  it('writes file to disk', async () => {
    const res = await postImage('pod_demo_01', makeTinyJpegBlob());
    expect(res.status).toBe(200);
    const { imageId } = await res.json() as { imageId: string };
    const filePath = path.join(testMediaDir, 'images', `${imageId}.jpg`);
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe('GET /media/images/:filename', () => {
  let uploadedImageId: string;

  beforeAll(async () => {
    const res = await postImage('pod_demo_01', makeTinyJpegBlob());
    const body = await res.json() as { imageId: string };
    uploadedImageId = body.imageId;
  });

  it('returns 200 with image/jpeg content-type', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/media/images/${uploadedImageId}.jpg`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('returns 404 for non-existent image', async () => {
    const res = await app.fetch(
      new Request('http://localhost/media/images/img_notreal.jpg')
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pods/:id after uploads — recentSnaps', () => {
  it('includes recentSnaps with thumb URLs after uploads', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/pods/pod_demo_01')
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      recentSnaps: Array<{ id: string; thumb: string | null; rating: string | null }>;
      capturedCount: number;
    };
    expect(Array.isArray(body.recentSnaps)).toBe(true);
    expect(body.recentSnaps.length).toBeGreaterThan(0);
    // Verify thumb URLs are well-formed
    for (const snap of body.recentSnaps) {
      expect(snap.thumb).toMatch(/^\/media\/images\/img_[a-f0-9]+\.jpg$/);
    }
    // recentSnaps should be capped at 5
    expect(body.recentSnaps.length).toBeLessThanOrEqual(5);
  });
});

