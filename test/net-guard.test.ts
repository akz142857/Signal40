import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateHostname, isPrivateIpAddress, parseIpLiteral } from '../lib/net-guard.ts';
import { assertPublicHttpUrl } from '../lib/source-adapters.ts';

void test('IP 字面量解析覆盖 IPv4、IPv6 与内嵌 IPv4 写法', () => {
  assert.deepEqual(parseIpLiteral('127.0.0.1'), { family: 4, bytes: [127, 0, 0, 1] });
  assert.deepEqual(parseIpLiteral('[::1]')?.bytes.at(-1), 1);
  assert.deepEqual(parseIpLiteral('::ffff:127.0.0.1')?.bytes.slice(10), [255, 255, 127, 0, 0, 1]);
  assert.equal(parseIpLiteral('example.com'), null);
  assert.equal(parseIpLiteral('999.1.1.1'), null);
  assert.equal(parseIpLiteral('::1::2'), null);
});

void test('私有与保留网段判定覆盖 IPv6 ULA、链路本地与映射地址', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2002:7f00:0001::1',
    '64:ff9b::10.0.0.1',
  ]) {
    assert.equal(isPrivateIpAddress(address), true, `${address} 应判定为私有或保留地址`);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2002:0808:0808::1']) {
    assert.equal(isPrivateIpAddress(address), false, `${address} 应判定为公网地址`);
  }
});

void test('主机名判定拦截本机命名空间', () => {
  for (const host of ['localhost', 'api.localhost', 'db.local', 'svc.internal', 'router.home.arpa', '[::1]']) {
    assert.equal(isPrivateHostname(host), true, `${host} 应判定为内网主机名`);
  }
  assert.equal(isPrivateHostname('news.example.com'), false);
});

void test('来源 URL 校验拦截 IPv6 与十进制/十六进制 IPv4 写法', () => {
  for (const url of [
    'http://127.0.0.1/feed',
    'http://2130706433/feed',
    'http://0x7f000001/feed',
    'http://[::1]/feed',
    'http://[::ffff:127.0.0.1]/feed',
    'http://[fd00::1]/feed',
    'http://[fe80::1]/feed',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:8787/feed',
  ]) {
    assert.throws(() => assertPublicHttpUrl(url), /不能指向本地或私有网络/, url);
  }
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /必须使用 HTTP\(S\)/);
  assert.equal(assertPublicHttpUrl('https://user:secret@news.example.com/rss'), 'https://news.example.com/rss');
});
