import { Hono } from 'hono';
import { logger } from 'hono/logger';
import health from './routes/health.js';
import pods from './routes/pods.js';
import meals from './routes/meals.js';
import { seedIfEmpty } from './seed.js';

// Run schema + seed on startup
seedIfEmpty();

// Warn loudly at startup if pipeline credentials are missing
const missingAtStartup: string[] = [];
if (!process.env.GEMINI_API_KEY) missingAtStartup.push('GEMINI_API_KEY');
if (!process.env.ELEVENLABS_API_KEY) missingAtStartup.push('ELEVENLABS_API_KEY');
if (missingAtStartup.length > 0) {
  console.warn(
    `[startup] WARNING: ${missingAtStartup.join(', ')} not set. ` +
    'POST /api/pods/:id/complete will return 503 until keys are configured. ' +
    'See README.md § Environment Variables or DEPLOY.md § Prerequisites.'
  );
}

export const app = new Hono();

app.use('*', logger());

// Mount routes
app.route('/', health);
app.route('/', pods);
app.route('/', meals);

// 404 fallback
app.notFound((c) => c.json({ error: 'not found' }, 404));

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);

console.log(`listening on ${HOST}:${PORT}`);

export default {
  fetch: app.fetch,
  hostname: HOST,
  port: PORT,
};

