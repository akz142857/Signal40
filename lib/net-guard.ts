/**
 * IP 字面量解析与私有/保留网段判定。
 *
 * 控制面（Workers 运行时）与 Render Worker（Node 运行时）共用同一份判定逻辑：
 * 控制面用它检查来源 URL 主机名，Worker 用它检查 DNS 解析结果，避免两边规则漂移。
 * 判定基于解析出的地址字节，而不是字符串前缀匹配。
 */

type ParsedIp = { family: 4 | 6; bytes: number[] };

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

function isPrivateIpv4(bytes: number[]) {
  const [a, b] = bytes;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 回环
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && bytes[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 88 && bytes[2] === 99) return true; // 192.88.99/24 6to4 中继
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a >= 224) return true; // 224/4 组播与 240/4 保留
  return false;
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
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 唯一本地地址
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  if (bytes[0] === 0xff) return true; // ff00::/8 组播
  return false;
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
