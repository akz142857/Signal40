import { config, db } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';
import { verifyWebhookSignature, webhookPayloadHash } from '@/lib/webhook-auth';

const MAX_BODY_BYTES = 256_000;

export async function POST(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return Response.json({ error: 'Webhook 请求体过大。' }, { status: 413 });
  const eventId = request.headers.get('x-signal-event-id')?.trim();
  const timestamp = request.headers.get('x-signal-timestamp')?.trim() || '';
  const signature = request.headers.get('x-signal-signature')?.trim() || '';
  if (!eventId || eventId.length > 200 || !config.webhookSecret) return Response.json({ error: 'Webhook 未配置或缺少事件 ID。' }, { status: 401 });
  if (!(await verifyWebhookSignature({ body: raw, timestamp, signature, secret: config.webhookSecret }))) return Response.json({ error: 'Webhook 签名无效或已超出 5 分钟时间窗。' }, { status: 401 });
  const existing = await db.prepare("SELECT id, status FROM webhook_events WHERE provider = 'youtube' AND external_event_id = ? LIMIT 1").bind(eventId).first<{ id: string; status: string }>();
  if (existing) return Response.json({ eventId, status: existing.status, replayed: true });
  let body: { publishJobId?: string; status?: string; externalId?: string; occurredAt?: string };
  try { body = JSON.parse(raw) as typeof body; } catch { return Response.json({ error: 'Webhook 请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.publishJobId || !['published', 'failed', 'withdrawn'].includes(body.status || '')) return Response.json({ error: 'publishJobId 或 status 无效。' }, { status: 422 });
  const publish = await db.prepare("SELECT id, project_id FROM publish_jobs WHERE id = ? AND channel = 'youtube' LIMIT 1").bind(body.publishJobId).first<{ id: string; project_id: string }>();
  if (!publish) return Response.json({ error: '对应的 YouTube 发布任务不存在。' }, { status: 404 });
  const now = new Date().toISOString();
  const occurredAt = body.occurredAt && !Number.isNaN(new Date(body.occurredAt).valueOf()) ? new Date(body.occurredAt).toISOString() : null;
  const webhookId = `webhook_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare("INSERT INTO webhook_events (id, provider, external_event_id, signature_hash, payload_hash, status, occurred_at, payload_json, received_at) VALUES (?, 'youtube', ?, ?, ?, 'processed', ?, ?, ?)").bind(webhookId, eventId, stableHash(signature), webhookPayloadHash(raw), occurredAt, raw, now),
    db.prepare('UPDATE publish_jobs SET status = ?, external_id = COALESCE(?, external_id), updated_at = ? WHERE id = ?').bind(body.status, body.externalId ?? null, now, body.publishJobId),
    db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, 'youtube-webhook', 'publisher', 'publish.webhook_received', 'publish_job', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, publish.project_id, body.publishJobId, webhookPayloadHash(raw), JSON.stringify({ eventId, status: body.status }), crypto.randomUUID(), now),
  ]);
  return Response.json({ eventId, status: 'processed' }, { status: 202 });
}
