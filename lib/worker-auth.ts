export async function authorizeWorker(request: Request, configuredToken?: string) {
  const supplied = request.headers.get('x-worker-token') || '';
  const host = new URL(request.url).hostname;
  if (!configuredToken && ['localhost', '127.0.0.1'].includes(host)) return supplied === 'local-development';
  if (!configuredToken || !supplied) return false;
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(configuredToken)),
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedHash);
  const actual = new Uint8Array(suppliedHash);
  let mismatch = expected.length ^ actual.length;
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) mismatch |= expected[index] ^ actual[index];
  return mismatch === 0;
}
