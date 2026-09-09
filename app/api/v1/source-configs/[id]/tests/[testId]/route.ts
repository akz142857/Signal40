import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import {
  projectPublicSourceTestRecord,
} from '@/lib/source-public-projection';

function parseJson(value: unknown, fallback: unknown) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

export async function GET(request: Request, context: { params: Promise<{ id: string; testId: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) {
    return sourceApiError('当前角色无权查看来源测试。', 403);
  }
  const { id, testId } = await context.params;
  const test = await db.prepare(`
    SELECT id, status, preview_json, capabilities_json, error_code, expires_at,
      created_at, finished_at
    FROM source_connection_tests WHERE id = ? AND source_config_id = ? LIMIT 1
  `).bind(testId, id).first<Record<string, unknown>>();
  if (!test) return sourceApiError('来源测试不存在。', 404);
  const preview = parseJson(test.preview_json, []);
  const capabilities = parseJson(test.capabilities_json, {});
  return Response.json({
    test: projectPublicSourceTestRecord({ ...test, preview, capabilities }),
  });
}
