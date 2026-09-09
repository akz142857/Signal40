import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * INSERT 的列数必须等于值数。
 *
 * 这类错误历史上出过两次，且都在路由里：team_members 写成 8 列 9 值、
 * source_configs 写成 33 列 31 值（后者还让 'draft'/'unknown'/'pending'
 * 整体错位两列，落到 collection_policy_json/capabilities_json/source_type 上）。
 * 两次都能通过 lint、tsc 和全部 260 项测试——因为 `npm test` 覆盖的是 lib/，
 * 而路由里的 SQL 从来没有被执行过：现有的“路由测试”只是把源码当文本读。
 *
 * 所以这里不测行为，只做一件事：把仓库里所有 INSERT 的列数和值数对齐。
 * 它拦不住语义错位（值放对了数量但放错了列），但上面两个真实缺陷都是
 * 数量先对不上，先把这条守住。
 */

/** 去掉单引号字符串字面量，避免 JSON 里的逗号被当成分隔符。'' 是转义的单引号。 */
function stripStringLiterals(sql: string) {
  let out = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (inString) {
      if (character === "'") {
        if (sql[index + 1] === "'") index += 1;
        else inString = false;
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      out += "''";
      continue;
    }
    out += character;
  }
  return out;
}

/** 从 openIndex 处的 '(' 读到配对的 ')'，返回括号内内容和右括号位置。 */
function readBalanced(sql: string, openIndex: number) {
  let depth = 0;
  for (let index = openIndex; index < sql.length; index += 1) {
    if (sql[index] === '(') depth += 1;
    else if (sql[index] === ')') {
      depth -= 1;
      if (depth === 0) return { body: sql.slice(openIndex + 1, index), end: index };
    }
  }
  return null;
}

/** 按顶层逗号切分，忽略子查询等嵌套括号内部的逗号。 */
function splitTopLevel(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.filter((part) => part.trim().length > 0);
}

async function sourceFiles(root: string) {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
      } else if (entry.name.endsWith('.ts')) found.push(full);
    }
  }
  await walk(root);
  return found;
}

void test('每条 INSERT 的列数与值数一致', async () => {
  const roots = ['app', 'lib', 'render-worker', 'scripts', 'db', 'test'];
  const mismatches: string[] = [];
  let inspected = 0;

  for (const root of roots) {
    for (const file of await sourceFiles(new URL(`../${root}`, import.meta.url).pathname)) {
      const raw = await readFile(file, 'utf8');
      const sql = stripStringLiterals(raw);
      const pattern = /INSERT\s+INTO\s+[A-Za-z_][\w.]*\s*\(/gi;
      for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
        const columnsAt = sql.indexOf('(', match.index);
        const columns = readBalanced(sql, columnsAt);
        if (!columns) continue;
        const afterColumns = sql.slice(columns.end + 1);
        // 只看 `... ) VALUES (`；INSERT ... SELECT 形式不在此检查范围内。
        const valuesMatch = /^\s*VALUES\s*\(/i.exec(afterColumns);
        if (!valuesMatch) continue;
        const valuesAt = columns.end + 1 + valuesMatch[0].lastIndexOf('(');
        const values = readBalanced(sql, valuesAt);
        if (!values) continue;

        inspected += 1;
        const columnCount = splitTopLevel(columns.body).length;
        const valueCount = splitTopLevel(values.body).length;
        if (columnCount !== valueCount) {
          const line = raw.slice(0, match.index).split('\n').length;
          const relative = path.relative(new URL('..', import.meta.url).pathname, file);
          mismatches.push(`${relative}:${line} 列=${columnCount} 值=${valueCount}`);
        }
      }
    }
  }

  assert.ok(inspected > 40, `应当扫描到足够多的 INSERT，实际 ${inspected}`);
  assert.deepEqual(mismatches, [], `INSERT 列数与值数不一致：\n${mismatches.join('\n')}`);
});
