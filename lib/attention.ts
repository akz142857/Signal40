import type { SqlDatabase } from './sql.ts';
import { stableHash } from './hash.ts';

/**
 * 待办箱：自动化把自己处理不了的每一件事放到这里，等人来处理。
 *
 * 全自动意味着人不盯屏幕，所以待办不能只躺在页面里——`notifyPendingAttention`
 * 会把新产生的条目按既有的 HMAC 约定推到外部 Webhook。推送失败只记录原因，
 * 不影响条目本身：漏推一次通知可以补，丢掉一条待办不行。
 *
 * 去重键保证同一件事不会每轮 tick 重复产生一条；已处理的条目再次出现时重新打开，
 * 因为「修完又坏了」和「一直没修」需要区分。
 */

export const ATTENTION_KINDS = [
  'gate_blocked',
  'qc_failed',
  'dead_letter',
  'evidence_conflict',
  'budget_exceeded',
  'breaker_open',
  'auto_approval_rejected',
  'topic_quality',
  'no_worker',
  'incident_open',
  'metrics_due',
  'automation_actor_missing',
  'source_rights',
  'source_connector',
  'source_slo',
  'source_budget',
  'source_ownership',
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type AttentionSeverity = 'info' | 'warning' | 'critical';

export type AttentionInput = {
  kind: AttentionKind;
  severity?: AttentionSeverity;
  projectId?: string | null;
  topicId?: string | null;
  policyId?: string | null;
  sourceConfigId?: string | null;
  dedupeKey: string;
  reason: string;
  detail?: unknown;
  /**
   * 同一条待办再次出现时是否重新打开（默认打开）。
   * 「修完又坏了」和「一直没修」需要区分；但对死信作业这种状态会一直挂着的来源，
   * 重开只会把处理过的事每轮 tick 再翻出来一次，那时传 false。
   */
  reopenResolved?: boolean;
};

export async function raiseAttentionItem(db: SqlDatabase, input: AttentionInput, now = new Date()) {
  const timestamp = now.toISOString();
  const id = `attention_${crypto.randomUUID()}`;
  const reopen = (input.reopenResolved ?? true) ? 1 : 0;
  const row = await db
    .prepare(`
      INSERT INTO attention_items
        (id, kind, severity, project_id, topic_id, policy_id, source_config_id,
         dedupe_key, reason, detail_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT (dedupe_key) DO UPDATE SET
        reason = excluded.reason,
        detail_json = excluded.detail_json,
        severity = excluded.severity,
        source_config_id = COALESCE(excluded.source_config_id, attention_items.source_config_id),
        updated_at = excluded.updated_at,
        -- 重新打开时才清掉处置痕迹；reopen = 0 的来源（例如一直挂着的死信作业行）
        -- 原样保留已处理状态，否则每轮 tick 都会把处理过的事再翻出来。
        status = CASE WHEN attention_items.status = 'resolved' AND ? = 0 THEN 'resolved' ELSE 'open' END,
        resolved_by = CASE WHEN attention_items.status = 'resolved' AND ? = 0 THEN attention_items.resolved_by ELSE NULL END,
        resolved_at = CASE WHEN attention_items.status = 'resolved' AND ? = 0 THEN attention_items.resolved_at ELSE NULL END,
        notified_at = CASE WHEN attention_items.status = 'resolved' THEN (CASE WHEN ? = 0 THEN attention_items.notified_at ELSE NULL END) ELSE attention_items.notified_at END
      RETURNING id, status, created_at
    `)
    .bind(
      id,
      input.kind,
      input.severity ?? 'warning',
      input.projectId ?? null,
      input.topicId ?? null,
      input.policyId ?? null,
      input.sourceConfigId ?? null,
      input.dedupeKey,
      input.reason.slice(0, 2000),
      JSON.stringify(input.detail ?? {}),
      timestamp,
      timestamp,
      reopen,
      reopen,
      reopen,
      reopen,
    )
    .first<{ id: string; status: string; created_at: string }>();
  return { id: row?.id ?? id, created: row?.created_at === timestamp };
}

export type AttentionRow = {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  project_id: string | null;
  topic_id: string | null;
  policy_id: string | null;
  source_config_id: string | null;
  dedupe_key: string;
  reason: string;
  status: 'open' | 'resolved';
  notified_at: string | null;
  notify_error: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function listAttentionItems(
  db: SqlDatabase,
  options: { status?: 'open' | 'resolved' | 'all'; projectId?: string; limit?: number } = {},
): Promise<Array<AttentionRow & { detail: unknown }>> {
  const status = options.status ?? 'open';
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const result = await db
    .prepare(`
      SELECT id, kind, severity, project_id, topic_id, policy_id, source_config_id,
             dedupe_key, reason, detail_json,
             status, notified_at, notify_error, resolved_by, resolved_at, created_at, updated_at
      FROM attention_items
      WHERE (? = 'all' OR status = ?) AND (? = '' OR project_id = ?)
      ORDER BY created_at DESC LIMIT ?
    `)
    .bind(status, status, options.projectId ?? '', options.projectId ?? '', limit)
    .all<AttentionRow & { detail_json: string }>();
  return result.results.map((row) => {
    let detail: unknown = {};
    try { detail = JSON.parse(String(row.detail_json)); } catch { detail = {}; }
    const { detail_json: _ignored, ...rest } = row;
    return { ...rest, detail };
  });
}

export async function resolveAttentionItem(
  db: SqlDatabase,
  input: { id: string; actor: { id: string; role: string }; note: string },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  const updated = await db
    .prepare("UPDATE attention_items SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'open'")
    .bind(input.actor.id, timestamp, timestamp, input.id)
    .run();
  if (!updated.meta.changes) return { error: '待办不存在或已处理。', status: 404 as const };
  await db
    .prepare(`
      INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'attention.resolved', 'attention_item', ?, ?, ?, ?, ?)
    `)
    .bind(`audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, input.id, stableHash({ id: input.id, note: input.note }), JSON.stringify({ note: input.note.slice(0, 1000) }), crypto.randomUUID(), timestamp)
    .run();
  return { id: input.id, status: 200 as const };
}

async function signPayload(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 推送尚未通知的待办。签名格式与入站 Webhook 一致：`HMAC(secret, "<timestamp>.<body>")`。
 *
 * 目标地址来自环境变量而不是用户输入，所以这里不做 SSRF 检查——
 * 自建部署把通知发给内网端点是正常需求，按公网地址硬性限制反而会挡掉它。
 */
export async function notifyPendingAttention(
  db: SqlDatabase,
  options: { url?: string; secret?: string; limit?: number; fetchImpl?: typeof fetch },
  now = new Date(),
) {
  if (!options.url) return { sent: 0, failed: 0, skipped: 'notify_url_missing' as const };
  if (!options.secret) return { sent: 0, failed: 0, skipped: 'notify_secret_missing' as const };
  const doFetch = options.fetchImpl ?? fetch;
  const pending = await db
    .prepare("SELECT id, kind, severity, project_id, topic_id, policy_id, source_config_id, reason, detail_json, created_at FROM attention_items WHERE status = 'open' AND notified_at IS NULL ORDER BY created_at ASC LIMIT ?")
    .bind(Math.min(50, Math.max(1, options.limit ?? 20)))
    .all<Record<string, unknown>>();
  let sent = 0;
  let failed = 0;
  for (const item of pending.results) {
    const body = JSON.stringify({
      type: 'signal40.attention',
      id: item.id,
      kind: item.kind,
      severity: item.severity,
      projectId: item.project_id,
      topicId: item.topic_id,
      policyId: item.policy_id,
      sourceConfigId: item.source_config_id,
      reason: item.reason,
      createdAt: item.created_at,
    });
    const timestamp = Math.floor(now.valueOf() / 1000).toString();
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-signal40-timestamp': timestamp };
      headers['x-signal40-signature'] = await signPayload(options.secret, timestamp, body);
      const response = await doFetch(options.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await db.prepare('UPDATE attention_items SET notified_at = ?, notify_error = NULL, updated_at = ? WHERE id = ?').bind(now.toISOString(), now.toISOString(), item.id).run();
      sent += 1;
    } catch (error) {
      await db.prepare('UPDATE attention_items SET notify_error = ?, updated_at = ? WHERE id = ?').bind((error instanceof Error ? error.message : String(error)).slice(0, 500), now.toISOString(), item.id).run();
      failed += 1;
    }
  }
  return { sent, failed };
}
