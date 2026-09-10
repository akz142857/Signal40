import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_NAVIGATION, navigationPathIsActive, PAGE_WIDTH_CLASSES } from '../lib/page-shell.ts';

void test('全站导航只有一份稳定的桌面/移动信息架构', () => {
  assert.deepEqual(GLOBAL_NAVIGATION.map(({ href, label }) => [href, label]), [
    ['/', '雷达'],
    ['/sources', '来源'],
    ['/automation', '自动化'],
    ['/inbox', '待办'],
    ['/operations', '运营'],
    ['/governance', '治理'],
    ['/settings/diagnostics', '系统'],
  ]);
  assert.equal(navigationPathIsActive('/sources/detail', '/sources'), true);
  assert.equal(navigationPathIsActive('/projects/project-1', '/'), true, '项目工作台保持雷达父级 active');
  assert.equal(navigationPathIsActive('/governance', '/operations'), false);
});

void test('页面主容器只暴露 Standard、Wide、Workspace 三个宽度 token', () => {
  assert.deepEqual(PAGE_WIDTH_CLASSES, {
    standard: 'max-w-6xl',
    wide: 'max-w-7xl',
    workspace: 'max-w-[1500px]',
  });
});
