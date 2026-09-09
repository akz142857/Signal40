import { config, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { parseSourceCredentialPolicies, publicSourceCredentialPolicies } from '@/lib/source-credentials';
import { sourceActionAllowed } from '@/lib/source-authorization';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.governance.read')) {
    return sourceApiError('当前角色无权查看来源凭据策略。', 403);
  }
  try {
    return Response.json({ policies: publicSourceCredentialPolicies(parseSourceCredentialPolicies(config.sourceCredentialPoliciesJson)) });
  } catch (error) {
    return sourceApiError(error instanceof Error ? error.message : '来源凭据策略配置无效。', 503, {
      errorCode: 'BROKER_CONFIG',
    });
  }
}
