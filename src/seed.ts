import db from './db.js';

export function seedIfEmpty(): void {
  const row = db.query('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (row.count > 0) return;

  console.log('[seed] seeding demo user and pod...');

  db.query(`
    INSERT INTO users (id, email, name, profile, daily_targets)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run(
    'usr_demo_01',
    'demo@everbetter.com',
    'Sienna Chen',
    JSON.stringify({
      age: 32,
      weight_lbs: 140,
      height_in: 65,
      goals: ['weight_loss', 'energy'],
    }),
    JSON.stringify({
      calories: 1800,
      protein_g: 120,
      carbs_g: 180,
      fat_g: 60,
    })
  );

  db.query(`
    INSERT INTO pods (id, user_id, target_count, captured_count, status)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run('pod_demo_01', 'usr_demo_01', 7, 0, 'collecting');

  console.log('[seed] done — usr_demo_01 + pod_demo_01 inserted');
}
