import { db } from '@/lib/runtime';

export async function GET() {
  const checkedAt = new Date().toISOString();
  try {
    const [database, queue] = await Promise.all([
      db.prepare('SELECT 1 AS ready').first<{ ready: number }>(),
      db.prepare("SELECT SUM(CASE WHEN status IN ('queued', 'retrying', 'leased') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter FROM jobs").first<{ active: number | null; dead_letter: number | null }>(),
    ]);
    return Response.json({ status: Number(queue?.dead_letter ?? 0) > 0 ? 'degraded' : 'ok', checkedAt, checks: { database: database?.ready === 1, queue: { active: Number(queue?.active ?? 0), deadLetter: Number(queue?.dead_letter ?? 0) } } });
  } catch {
    return Response.json({ status: 'unhealthy', checkedAt, checks: { database: false } }, { status: 503 });
  }
}
