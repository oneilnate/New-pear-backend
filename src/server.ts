import { Hono } from 'hono';
import { logger } from 'hono/logger';
import health from './routes/health.js';
import pods from './routes/pods.js';
import meals from './routes/meals.js';
import { seedIfEmpty } from './seed.js';

// Run schema + seed on startup
seedIfEmpty();

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

