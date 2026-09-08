import { config, db, resolveRequestActor, storage } from '@/lib/runtime';
import { runDiagnostics } from '@/lib/diagnostics';

/**
 * 系统自检。只有管理员和审计员能看：结论里包含哪些凭据没配、队列积压多少，
 * 属于运维信息。任何情况下都不回显密钥本身。
 */
export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看系统自检。' }, { status: 403 });
  const result = await runDiagnostics({
    db,
    storage,
    env: {
      s3Endpoint: process.env.S3_ENDPOINT,
      s3Bucket: process.env.S3_BUCKET,
      s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
      s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      openAiApiKey: process.env.OPENAI_API_KEY,
      youtubeAccessToken: process.env.YOUTUBE_ACCESS_TOKEN,
      workerToken: config.workerToken,
      schedulerToken: config.schedulerToken,
      mediaSigningSecret: config.mediaSigningSecret,
      automationActorId: config.automationActorId,
      allowPublicPublish: process.env.SIGNAL40_ALLOW_PUBLIC_PUBLISH === 'true',
    },
  });
  return Response.json(result);
}
