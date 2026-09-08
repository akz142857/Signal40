function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function signaturePayload(objectKey: string, expires: number) {
  return `${expires}\n${objectKey}`;
}

export async function signMediaAccess(secret: string, objectKey: string, expires: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signaturePayload(objectKey, expires))));
}

export async function verifyMediaAccess(secret: string, objectKey: string, expires: number, signature: string, now = Date.now()) {
  if (!Number.isInteger(expires) || expires * 1000 < now || expires * 1000 > now + 15 * 60_000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = await signMediaAccess(secret, objectKey, expires);
  let difference = expected.length ^ signature.length;
  for (let index = 0; index < Math.max(expected.length, signature.length); index += 1) difference |= (expected.charCodeAt(index) || 0) ^ (signature.charCodeAt(index) || 0);
  return difference === 0;
}
