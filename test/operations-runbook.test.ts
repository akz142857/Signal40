import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('restore runbook matches the destructive-operation guards in the script', async () => {
  const [runbook, restoreScript] = await Promise.all([
    readFile('docs/OPERATIONS_RUNBOOK.md', 'utf8'),
    readFile('scripts/restore-local.sh', 'utf8'),
  ]);

  assert.doesNotMatch(runbook, /RESTORE_PERSIST_TO/);
  assert.match(
    runbook,
    /CONFIRM_RESTORE=isolated RESTORE_TARGET_DB=signal40_restore_[a-z0-9_]+ \.\/scripts\/restore-local\.sh backups\/drill/,
  );

  assert.match(restoreScript, /\$\{CONFIRM_RESTORE:-\}.*isolated/);
  assert.match(restoreScript, /signal40_restore_\*\)/);
  assert.match(restoreScript, /目标库 .* 已存在，拒绝覆盖/);
});
