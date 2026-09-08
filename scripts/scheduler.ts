import { closeDatabase, config, db, storage } from '../lib/runtime.ts';
import { runAutomationTick } from '../lib/orchestrator.ts';

/**
 * 调度器进程：常驻，默认 30 秒一轮，调用 `lib/orchestrator.ts`。
 *
 * 它必须是独立进程而不是控制面里的 `setInterval`：vinext 没有 instrumentation /
 * startup 钩子，模块级定时器只会在该模块被首个请求引入时才启动，
 * dev 模式 HMR 还可能重复注册。和 Render Worker 同构，`docker compose` 里各起一个。
 *
 * 一轮没跑完不会开下一轮——tick 自身有工作量上限，重叠只会让锁互相打架。
 */

const intervalMs = Math.max(5_000, Number(process.env.SIGNAL40_SCHEDULER_INTERVAL_MS ?? 30_000));
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    process.stdout.write(`\n收到 ${signal}，本轮结束后退出。\n`);
  });
}

process.stdout.write(`Signal 40 调度器已启动，间隔 ${intervalMs} ms。\n`);

while (!stopping) {
  const startedAt = Date.now();
  try {
    const result = await runAutomationTick({
      db,
      storage,
      trigger: 'scheduler',
      automationActorId: config.automationActorId,
      monthlyRenderBudgetMicros: Number(config.monthlyRenderBudgetMicros ?? 0),
      notify: { url: config.attentionWebhookUrl, secret: config.webhookSecret },
    });
    const summary = `${result.status} 项目 ${result.projectCount} 动作 ${result.actions.length} 错误 ${result.errors.length}`;
    process.stdout.write(`${new Date().toISOString()} tick ${summary}${result.skippedReason ? `（${result.skippedReason}）` : ''}\n`);
  } catch (error) {
    // 单轮异常不能让常驻进程退出：记录后等下一轮，容器不用靠重启拉起来。
    process.stderr.write(`${new Date().toISOString()} tick 失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
  const elapsed = Date.now() - startedAt;
  if (stopping) break;
  await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, intervalMs - elapsed)));
}

await closeDatabase();
process.stdout.write('调度器已停止。\n');
