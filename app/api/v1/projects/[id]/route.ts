import { env } from 'cloudflare:workers';
import { loadContentProject } from '@/lib/control-plane';
import { computeRenderSnapshotHash, validateProjectV2, type VideoProjectV2 } from '@/lib/project-v2';
import { getVideoTemplate } from '@/lib/templates';
import { parseIfMatch, quoteEtag, resolveActor, stableHash } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  try {
    const project = await loadContentProject(env.DB, id);
    if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
    return Response.json({ project }, { headers: { ETag: quoteEtag(project.version) } });
  } catch {
    return Response.json({ error: '项目读取失败。' }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const expectedVersion = parseIfMatch(request.headers.get('if-match'));
  if (expectedVersion === null) return Response.json({ error: '必须提供格式为 "版本号" 的 If-Match。' }, { status: 428 });
  let body: {
    templateId?: string;
    brand?: string;
    locale?: string;
    distribution?: Partial<VideoProjectV2['distribution']>;
  };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const changesProduction = body.templateId !== undefined || body.brand !== undefined || body.locale !== undefined;
  const changesDistribution = body.distribution !== undefined;
  if (!changesProduction && !changesDistribution) return Response.json({ error: '没有可保存的生产配置。' }, { status: 422 });
  if (changesProduction && !['producer', 'admin'].includes(actor.role)) return Response.json({ error: '只有制作人可以修改模板、品牌或语言。' }, { status: 403 });
  if (changesDistribution && !['publisher', 'admin'].includes(actor.role)) return Response.json({ error: '只有发布者可以修改渠道配置。' }, { status: 403 });
  const { id } = await context.params;
  const project = await loadContentProject(env.DB, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (project.version !== expectedVersion) return Response.json({ error: `版本冲突：当前版本为 ${project.version}。` }, { status: 409 });
  if (['RENDER_QUEUED', 'RENDERING', 'PUBLISH_SCHEDULED', 'PUBLISHED', 'MEASURED', 'CANCELLED'].includes(project.state)) return Response.json({ error: `项目处于 ${project.state}，请先撤销、退回或创建更正版本。` }, { status: 409 });
  const nextProject = structuredClone(project.project);
  if (body.templateId !== undefined) {
    const template = getVideoTemplate(body.templateId);
    if (template.id !== body.templateId) return Response.json({ error: '模板不存在。' }, { status: 422 });
    nextProject.render.templateId = template.id;
    nextProject.render.templateVersion = template.version;
  }
  if (body.brand !== undefined) {
    const brand = body.brand.trim();
    if (!brand || brand.length > 80) return Response.json({ error: '品牌名称必须为 1–80 个字符。' }, { status: 422 });
    nextProject.identity.brand = brand;
  }
  if (body.locale !== undefined) {
    if (!/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?$/.test(body.locale)) return Response.json({ error: 'locale 必须是规范语言标签，例如 zh-CN 或 en-US。' }, { status: 422 });
    nextProject.identity.locale = body.locale;
  }
  if (body.distribution) {
    const distribution = { ...nextProject.distribution, ...body.distribution };
    if (distribution.channelPreset && !['package', 'youtube'].includes(distribution.channelPreset)) return Response.json({ error: 'channelPreset 必须是 package、youtube 或 null。' }, { status: 422 });
    if (!distribution.title?.trim() || distribution.title.length > 100 || distribution.description.length > 5000) return Response.json({ error: '渠道标题必须为 1–100 字，描述最多 5000 字。' }, { status: 422 });
    if ((distribution.tags?.length ?? 0) > 30 || distribution.tags?.some((tag) => !tag.trim() || tag.length > 50)) return Response.json({ error: '最多 30 个标签，每个标签为 1–50 字。' }, { status: 422 });
    if (distribution.scheduledAt && Number.isNaN(new Date(distribution.scheduledAt).valueOf())) return Response.json({ error: 'scheduledAt 无效。' }, { status: 422 });
    if (distribution.coverAssetId) {
      const cover = await env.DB.prepare("SELECT id FROM assets WHERE id = ? AND project_id = ? AND media_type LIKE 'image/%' AND rights_status = 'cleared'").bind(distribution.coverAssetId, id).first();
      if (!cover) return Response.json({ error: '封面必须引用本项目版权已清除的图片资产。' }, { status: 422 });
    }
    nextProject.distribution = distribution;
  }
  const nextSnapshotHash = computeRenderSnapshotHash(nextProject);
  nextProject.render.snapshotHash = nextSnapshotHash;
  nextProject.provenance.immutableInputsHash = nextSnapshotHash;
  const validation = validateProjectV2(nextProject);
  if (!validation.valid) return Response.json({ error: '更新后的项目协议无效。', issues: validation.errors }, { status: 422 });
  const nextProjectHash = stableHash(nextProject);
  const nextState = changesProduction && ['ASSETS_READY', 'QC_PENDING', 'QC_APPROVED'].includes(project.state)
    ? 'SCRIPT_APPROVED'
    : project.state;
  const now = new Date().toISOString();
  const [updated] = await env.DB.batch([
    env.DB.prepare('UPDATE content_projects SET brand = ?, locale = ?, project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind(nextProject.identity.brand, nextProject.identity.locale, JSON.stringify(nextProject), nextProjectHash, nextState, now, id, expectedVersion),
    env.DB.prepare(`
      INSERT INTO audit_events
        (id, project_id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      SELECT ?, ?, ?, ?, 'project.configuration_updated', 'content_project', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ? AND immutable_hash = ?)
    `).bind(`audit_${crypto.randomUUID()}`, id, actor.id, actor.role, id, project.immutableHash, nextProjectHash, JSON.stringify({ templateId: nextProject.render.templateId, templateVersion: nextProject.render.templateVersion, brand: nextProject.identity.brand, locale: nextProject.identity.locale, distribution: nextProject.distribution, approvalsInvalidated: true }), crypto.randomUUID(), now, id, expectedVersion + 1, now, nextProjectHash),
  ]);
  if (!updated.meta.changes) return Response.json({ error: '项目已被其他用户修改。' }, { status: 409 });
  const saved = await loadContentProject(env.DB, id);
  return Response.json({ project: saved }, { headers: { ETag: quoteEtag(expectedVersion + 1) } });
}
