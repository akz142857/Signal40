import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manager = fs.readFileSync('components/source-manager.tsx', 'utf8');
const operations = fs.readFileSync(
  'components/operations-dashboard.tsx',
  'utf8',
);
const connectorRelease = fs.readFileSync(
  'components/connector-release-control.tsx',
  'utf8',
);

void test('source UI configures priority and explains deterministic budget throttling', () => {
  for (const marker of [
    '来源调度优先级（0–100）',
    '达到预算软阈值后自动降频',
    '优先级 80–100 保持原频率、50–79 降为 1/2、0–49 降为 1/4',
    '每个跳过时点都会审计，不会掩盖真正漏调度',
    'schedulePriority',
    'autoThrottleEnabled',
    'effectiveScheduleMultiplier',
    'scheduleThrottleRecoveryAt',
  ]) {
    assert.ok(manager.includes(marker), marker);
  }
});

void test('operations UI exposes current multiplier, skipped count, and recovery time', () => {
  for (const marker of [
    '调度优先级',
    'budgetThrottled',
    'effectiveScheduleMultiplier',
    'throttleRecoveryAt',
    '已审计跳过',
  ]) {
    assert.ok(operations.includes(marker), marker);
  }
});

// 发布控制搬到了运维页，但它是连接器版本的控制面，不是来源的控制面：
// 断言跟着实现走到 connector-release-control，来源页只需要留下摘要和入口。
void test('connector release UI exposes stable-bucket canary and automatic stop controls', () => {
  for (const marker of [
    '灰度来源比例（1–100）',
    '自动停止失败率（0.01–100%）',
    '达到阈值前的最小运行数（1–10000）',
    '灰度按来源 ID',
    '稳定分桶',
    '未命中的来源自动走 shadow',
    'canaryFailureRateBps',
    'canaryMinRuns',
  ]) {
    assert.ok(connectorRelease.includes(marker), marker);
  }
  assert.ok(
    operations.includes('<ConnectorReleaseControl />'),
    '运维页挂载发布控制',
  );
  for (const marker of ['<ConnectorReleaseSummary', 'href="/operations"']) {
    assert.ok(
      manager.includes(marker) || connectorRelease.includes(marker),
      marker,
    );
  }
});
