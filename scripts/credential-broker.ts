import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handleCredentialBrokerFetch } from '../lib/credential-broker-handler.ts';
import { closeDatabase, db } from '../lib/runtime.ts';
import { parseSourceCredentialPolicies } from '../lib/source-credentials.ts';
import { resolveCredentialBrokerEnvironment } from '../lib/workload-env.ts';

const MAX_REQUEST_BYTES = 64 * 1024;
const brokerEnvironment = resolveCredentialBrokerEnvironment(process.env);
const policies = parseSourceCredentialPolicies(brokerEnvironment.policiesJson);

if (brokerEnvironment.production) {
  const missingProviders = [...new Set(Object.values(policies).map((policy) => policy.secretEnv))]
    .filter((name) => !process.env[name]);
  if (missingProviders.length) {
    throw new Error(`Credential Broker 缺少已登记的 provider Secret：${missingProviders.join(', ')}`);
  }
}

async function readBody(request: IncomingMessage) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    request.resume();
    return null;
  }
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        settled = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function sendJson(response: ServerResponse, status: number, payload: Record<string, unknown>) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'credential-broker'}`);
    if (incoming.method === 'GET' && url.pathname === '/healthz') {
      sendJson(outgoing, 200, { status: 'ok', service: 'credential-broker' });
      return;
    }
    if (incoming.method !== 'POST' || url.pathname !== '/api/v1/credential-broker/fetch') {
      sendJson(outgoing, 404, { error: 'Not found.' });
      return;
    }
    const body = await readBody(incoming);
    if (!body) {
      sendJson(outgoing, 413, { error: 'Request body too large.' });
      return;
    }
    const request = new Request(url, {
      method: 'POST',
      headers: incoming.headers as HeadersInit,
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    const result = await handleCredentialBrokerFetch(request, {
      db,
      sourceWorkerToken: brokerEnvironment.sourceWorkerToken,
      policiesJson: brokerEnvironment.policiesJson,
      resolveSecret: (environmentName) => process.env[environmentName],
    });
    outgoing.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    outgoing.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    process.stderr.write(`Credential Broker 请求失败：${error instanceof Error ? error.message : 'unknown'}\n`);
    if (!outgoing.headersSent) sendJson(outgoing, 500, { error: 'Credential Broker internal error.' });
    else outgoing.end();
  }
});

server.listen(brokerEnvironment.port, '0.0.0.0', () => {
  process.stdout.write(`Signal 40 Credential Broker listening on ${brokerEnvironment.port}\n`);
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
  });
}
