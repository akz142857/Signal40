import { config, db, storage } from '@/lib/runtime';
import { authorizeWorker } from '@/lib/worker-auth';

const MAX_RAW_BYTES = 5_000_000;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.workerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  const { id } = await context.params;
  const jobId = request.headers.get('x-job-id');
  const run = await db.prepare(`
    SELECT ir.source_config_id, ir.job_id, j.status AS job_status, sc.retention_mode, sc.retention_days
    FROM ingestion_runs ir JOIN jobs j ON j.id = ir.job_id JOIN source_configs sc ON sc.id = ir.source_config_id
    WHERE ir.id = ? LIMIT 1
  `).bind(id).first<{ source_config_id: string; job_id: string; job_status: string; retention_mode: string; retention_days: number }>();
  if (!run || run.job_id !== jobId || run.job_status !== 'leased') return Response.json({ error: '采集运行或 Worker 租约无效。' }, { status: 409 });
  if (run.retention_mode !== 'raw') return Response.json({ error: '该来源只允许保留必要元数据。' }, { status: 409 });
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_RAW_BYTES) return Response.json({ error: '原始载荷必须为 1 字节到 5 MB。' }, { status: 413 });
  const objectKey = `sources/${run.source_config_id}/raw/${id}/payload`;
  const deleteAfter = new Date(Date.now() + run.retention_days * 86_400_000).toISOString();
  await storage.put(objectKey, data, {
    contentType: request.headers.get('content-type') || 'application/octet-stream',
    customMetadata: { sourceConfigId: run.source_config_id, ingestionRunId: id, deleteAfter },
  });
  return Response.json({ objectKey, deleteAfter }, { status: 201 });
}
