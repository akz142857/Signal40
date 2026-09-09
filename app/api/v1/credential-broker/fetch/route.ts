import { handleCredentialBrokerFetch } from '@/lib/credential-broker-handler';
import { config, db } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';

export async function POST(request: Request) {
  if (process.env.SIGNAL40_DEPLOYMENT_MODE === 'production') {
    return sourceApiError('生产环境必须使用独立 Credential Broker。', 503, {
      errorCode: 'BROKER_CONFIG',
      retryable: false,
    });
  }
  return handleCredentialBrokerFetch(request, {
    db,
    sourceWorkerToken: config.sourceWorkerToken,
    policiesJson: config.sourceCredentialPoliciesJson,
    resolveSecret: (environmentName) => config.resolveSourceCredentialSecret(environmentName),
  });
}
