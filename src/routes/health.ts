import { Hono } from 'hono';

const health = new Hono();

health.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'food-pod-backend',
    ts: new Date().toISOString(),
  });
});

export default health;

