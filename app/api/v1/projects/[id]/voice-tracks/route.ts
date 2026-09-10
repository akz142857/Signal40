import { config, db, resolveRequestActor } from '@/lib/runtime';
import { loadContentProject } from '@/lib/control-plane';
import { computeRenderSnapshotHash, type VideoProjectV2 } from '@/lib/project-v2';
import { loadActiveJobLease } from '@/lib/job-lease';
import { authorizeWorker } from '@/lib/worker-auth';
import { stableHash } from '@/lib/workflow';
import { abandonIdempotentRequest, beginIdempotentRequest, completeIdempotencyStatement } from '@/lib/idempotency';

type VoiceCommit = {
  jobId?: string;
  assetId?: string;
  provider?: string;
  voice?: string;
  speed?: number;
  pronunciationDictionary?: Record<string, string>;
  fallbackProvider?: string | null;
  estimatedCostMicros?: number;
  durationMs?: number;
  alignment?: unknown[];
  captions?: VideoProjectV2['captions'];
  scriptVersion?: number;
  scriptHash?: string;
  workerId?: string;
  leaseEpoch?: number;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await db.prepare('SELECT id, script_version, provider, voice, object_key, duration_ms, alignment_json, created_at FROM voice_tracks WHERE project_id = ? ORDER BY created_at DESC').bind(id).all();
  return Response.json({ tracks: result.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.renderWorkerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: VoiceCommit;
  try { body = (await request.json()) as VoiceCommit; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.jobId || !body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1 || !body.assetId || !body.provider || !body.voice || !Number.isFinite(body.durationMs) || Number(body.durationMs) < 500 || !Array.isArray(body.alignment) || !Array.isArray(body.captions) || !Number.isInteger(body.scriptVersion) || !body.scriptHash) return Response.json({ error: '配音提交字段或租约身份不完整。' }, { status: 422 });
  const { id } = await context.params;
  const project = await loadContentProject(db, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (project.project.script.version !== body.scriptVersion || stableHash(project.project.script) !== body.scriptHash) return Response.json({ error: '脚本版本已变化，拒绝写入过期配音。' }, { status: 409 });
  const [job, asset] = await Promise.all([
    loadActiveJobLease(db, { jobId: body.jobId, workerId: body.workerId.slice(0, 160), leaseEpoch: Number(body.leaseEpoch), projectId: id, kinds: ['voice'] }),
    db.prepare("SELECT object_key, sha256 FROM assets WHERE id = ? AND project_id = ? AND media_type LIKE 'audio/%' AND rights_status = 'cleared'").bind(body.assetId, id).first<{ object_key: string; sha256: string }>(),
  ]);
  if (!job || !asset) return Response.json({ error: '配音作业租约或音频资产无效。' }, { status: 409 });
  const invalidCaption = body.captions.some((caption) => caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > Number(body.durationMs) + 250 || !caption.text.trim());
  if (invalidCaption) return Response.json({ error: '字幕时间轴无效。' }, { status: 422 });
  const idempotency = await beginIdempotentRequest(db, { scope: `worker.voice:${id}`, key: body.jobId, request: body });
  if (idempotency.kind === 'conflict') return Response.json({ error: '该配音作业已经提交过不同的结果。' }, { status: 409 });
  if (idempotency.kind === 'pending') return Response.json({ error: '相同配音结果正在提交。' }, { status: 425 });
  if (idempotency.kind === 'replay') return Response.json(idempotency.body, { status: idempotency.status, headers: { 'Idempotency-Replayed': 'true' } });
  const nextProject = structuredClone(project.project);
  nextProject.audio = {
    ...nextProject.audio,
    provider: body.provider,
    voice: body.voice,
    objectKey: asset.object_key.replace(/^public\//, ''),
    durationMs: Number(body.durationMs),
    speed: Number.isFinite(body.speed) && Number(body.speed) >= 0.5 && Number(body.speed) <= 2 ? Number(body.speed) : 1,
    pronunciationDictionary: body.pronunciationDictionary ?? {},
    sha256: asset.sha256,
    fallbackProvider: body.fallbackProvider ?? null,
    estimatedCostMicros: Number.isInteger(body.estimatedCostMicros) && Number(body.estimatedCostMicros) >= 0 ? Number(body.estimatedCostMicros) : 0,
    mix: nextProject.audio.mix ?? { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true },
  };
  nextProject.captions = body.captions;
  const immutableInputsHash = computeRenderSnapshotHash(nextProject);
  nextProject.render.snapshotHash = immutableInputsHash;
  nextProject.provenance.immutableInputsHash = immutableInputsHash;
  const now = new Date().toISOString();
  const voiceTrackId = `voice_${crypto.randomUUID()}`;
  const captionTrackId = `caption_${crypto.randomUUID()}`;
  const responseBody = { voiceTrackId, captionTrackId, snapshotHash: immutableInputsHash };
  try {
    await db.transaction(async (tx) => {
      const results = await tx.batch([
        tx.prepare(`UPDATE content_projects SET project_json = ?, immutable_hash = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND EXISTS (
            SELECT 1 FROM jobs WHERE id = ? AND project_id = ? AND kind = 'voice' AND status = 'leased'
              AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?
          )`).bind(JSON.stringify(nextProject), stableHash(nextProject), now, id, project.version, body.jobId, id, body.workerId!.slice(0, 160), Number(body.leaseEpoch), now),
        tx.prepare('INSERT INTO voice_tracks (id, project_id, script_version, provider, voice, object_key, duration_ms, speed_milli, pronunciation_json, audio_sha256, fallback_provider, cost_micros, alignment_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)').bind(voiceTrackId, id, body.scriptVersion, body.provider, body.voice, asset.object_key, Number(body.durationMs), Math.round(nextProject.audio.speed * 1000), JSON.stringify(nextProject.audio.pronunciationDictionary), asset.sha256, nextProject.audio.fallbackProvider, nextProject.audio.estimatedCostMicros, JSON.stringify(body.alignment), now, id, project.version + 1, now),
        tx.prepare("INSERT INTO caption_tracks (id, project_id, voice_track_id, format, content, created_at) SELECT ?, ?, ?, 'json', ?, ? WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)").bind(captionTrackId, id, voiceTrackId, JSON.stringify(body.captions), now, id, project.version + 1, now),
        tx.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) SELECT ?, ?, 'voice-worker', 'producer', 'voice.generated', 'voice_track', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)").bind(`audit_${crypto.randomUUID()}`, id, voiceTrackId, immutableInputsHash, JSON.stringify({ provider: body.provider, voice: body.voice, durationMs: body.durationMs, scriptVersion: body.scriptVersion, jobId: body.jobId }), crypto.randomUUID(), now, id, project.version + 1, now),
      ]);
      if (!results[0].meta.changes) throw new Error('LEASE_OR_VERSION_CONFLICT');
      await completeIdempotencyStatement(tx, idempotency.reservation, 200, responseBody).run();
    });
  } catch (error) {
    await abandonIdempotentRequest(db, idempotency.reservation);
    if (error instanceof Error && error.message === 'LEASE_OR_VERSION_CONFLICT') return Response.json({ error: '租约已失效或项目已被其他用户修改，配音结果未关联。' }, { status: 409 });
    return Response.json({ error: '配音结果保存失败。' }, { status: 503 });
  }
  return Response.json(responseBody);
}
