/**
 * IP 字面量解析与私有/保留网段判定。
 *
 * 控制面（Workers 运行时）与 Render Worker（Node 运行时）共用同一份判定逻辑：
 * 控制面用它检查来源 URL 主机名，Worker 用它检查 DNS 解析结果，避免两边规则漂移。
 * 判定基于解析出的地址字节，而不是字符串前缀匹配。
 */

type ParsedIp = { family: 4 | 6; bytes: number[] };

/**
 * 固定到 IANA 2025-10-09 special-purpose registries。
 *
 * Source egress 比通用浏览器更保守：除 IPv4-embedded translation 需要先解包
 * 判断真实目标外，registry 中的地址即使标为 globally reachable 也不作为内容来源
 * 目标。升级此版本时必须同时更新回归语料和威胁模型。
 *
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 */
export const IANA_SPECIAL_PURPOSE_REGISTRY_VERSION = '2025-10-09';

export const IANA_IPV4_SPECIAL_PURPOSE_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
] as const;

export const IANA_IPV6_SPECIAL_PURPOSE_CIDRS = [
  '::/128',
  '::1/128',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/23',
  '2001:db8::/32',
  '2620:4f:8000::/48',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
] as const;

// Multicast is maintained in separate IANA registries but is never a valid
// unicast content-source destination.
const NON_UNICAST_CIDRS = {
  4: ['224.0.0.0/4'],
  6: ['ff00::/8'],
} as const;

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6(value: string): number[] | null {
  const zoneIndex = value.indexOf('%');
  const address = zoneIndex === -1 ? value : value.slice(0, zoneIndex);
  if (!/^[0-9a-fA-F:.]*$/.test(address) || !address.includes(':')) return null;
  const doubleColon = address.indexOf('::');
  if (doubleColon !== address.lastIndexOf('::')) return null;
  const [headText, tailText] = doubleColon === -1
    ? [address, '']
    : [address.slice(0, doubleColon), address.slice(doubleColon + 2)];
  const groups: number[][] = [];
  const readSide = (side: string, allowIpv4: boolean) => {
    if (!side) return true;
    const pieces = side.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes('.')) {
        if (!allowIpv4 || index !== pieces.length - 1) return false;
        const embedded = parseIpv4(piece);
        if (!embedded) return false;
        groups.push([embedded[0], embedded[1]], [embedded[2], embedded[3]]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return false;
      const word = Number.parseInt(piece, 16);
      groups.push([word >>> 8, word & 0xff]);
    }
    return true;
  };
  if (!readSide(headText, doubleColon === -1)) return null;
  const headLength = groups.length;
  if (!readSide(tailText, true)) return null;
  const tailLength = groups.length - headLength;
  if (doubleColon === -1) return groups.length === 8 ? groups.flat() : null;
  if (groups.length >= 8) return null;
  const filler = Array.from({ length: 8 - groups.length }, () => [0, 0]);
  return [...groups.slice(0, headLength), ...filler, ...groups.slice(headLength, headLength + tailLength)].flat();
}

/** 解析 IP 字面量；接受 `[::1]` 形式的方括号写法。返回 null 表示不是 IP 字面量。 */
export function parseIpLiteral(host: string): ParsedIp | null {
  const value = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const ipv4 = parseIpv4(value);
  if (ipv4) return { family: 4, bytes: ipv4 };
  const ipv6 = parseIpv6(value);
  return ipv6 ? { family: 6, bytes: ipv6 } : null;
}

function matchesCidr(bytes: number[], network: number[], prefix: number) {
  if (bytes.length !== network.length || prefix < 0 || prefix > bytes.length * 8) {
    return false;
  }
  const fullBytes = Math.floor(prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== network[index]) return false;
  }
  const remaining = prefix % 8;
  if (!remaining) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes] & mask) === (network[fullBytes] & mask);
}

function inCidrs(bytes: number[], cidrs: readonly string[], family: 4 | 6) {
  for (const cidr of cidrs) {
    const [networkText, prefixText] = cidr.split('/');
    const network = family === 4 ? parseIpv4(networkText) : parseIpv6(networkText);
    if (network && matchesCidr(bytes, network, Number(prefixText))) return true;
  }
  return false;
}

function isPrivateIpv4(bytes: number[]) {
  return inCidrs(bytes, IANA_IPV4_SPECIAL_PURPOSE_CIDRS, 4) ||
    inCidrs(bytes, NON_UNICAST_CIDRS[4], 4);
}

function isPrivateIpv6(bytes: number[]) {
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  // ::ffff:0:0/96 IPv4 映射地址
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12));
  }
  // 64:ff9b::/96 NAT64
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return isPrivateIpv4(bytes.slice(12));
  }
  // 2002::/16 6to4：内嵌 IPv4 地址在第 2–5 字节
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPrivateIpv4(bytes.slice(2, 6));
  return inCidrs(bytes, IANA_IPV6_SPECIAL_PURPOSE_CIDRS, 6) ||
    inCidrs(bytes, NON_UNICAST_CIDRS[6], 6);
}

/** 判断一个 IP 字面量（或 DNS 解析结果）是否落在私有、回环、链路本地或其他保留网段。 */
export function isPrivateIpAddress(address: string) {
  const parsed = parseIpLiteral(address);
  if (!parsed) return false;
  return parsed.family === 4 ? isPrivateIpv4(parsed.bytes) : isPrivateIpv6(parsed.bytes);
}

/** 判断主机名本身是否指向本机或内网命名空间（不含 DNS 解析结果）。 */
export function isPrivateHostname(host: string) {
  const value = host.toLowerCase();
  if (!value) return true;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value.endsWith('.local') || value.endsWith('.internal') || value.endsWith('.home.arpa')) return true;
  return isPrivateIpAddress(value);
}
