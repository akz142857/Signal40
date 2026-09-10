import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { APP_BAR_WIDTH_CLASS, GLOBAL_NAVIGATION, navigationPathIsActive, PAGE_WIDTH_CLASSES } from '../lib/page-shell.ts';

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

void test('页面主容器只暴露普通页面和工作台两个宽度 token', () => {
  assert.deepEqual(PAGE_WIDTH_CLASSES, {
    page: 'max-w-7xl',
    workspace: 'max-w-[1500px]',
  });
});

/**
 * 外壳一致性只能靠结构保证：过去导航跟着 `PageHeader` 走，各页自己填品牌和标题，
 * 于是换一页左上角就换一个产品名，导航还会随页面 width token 横向跳。
 * 这里锁住“导航只在 AppBar、AppBar 只在根布局”这条约定。
 */
void test('全局应用条挂在根布局上，页面标题区不再自带导航', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /<AppBar \/>/, '根布局必须渲染 AppBar');

  const shell = readFileSync(new URL('../components/page-shell.tsx', import.meta.url), 'utf8');
  const pageHeader = shell.slice(shell.indexOf('export function PageHeader'));
  assert.doesNotMatch(pageHeader, /NavigationLinks|GLOBAL_NAVIGATION/, '页面标题区不能再渲染全站导航');
  assert.equal(APP_BAR_WIDTH_CLASS.startsWith('max-w-'), true, '应用条宽度必须是独立于页面的固定 token');
});

void test('页面组件不各自渲染全站导航', () => {
  for (const file of [
    'radar-dashboard.tsx',
    'source-manager.tsx',
    'operations-dashboard.tsx',
    'governance-dashboard.tsx',
    'automation-console.tsx',
    'attention-inbox.tsx',
    'diagnostics-panel.tsx',
    'workspace/project-workspace.tsx',
  ]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /GLOBAL_NAVIGATION|<AppBar/, `${file} 不应自带全站导航或应用条`);
  }
});

void test('页面不再各自声明内容宽度，避免逐页漂移', () => {
  for (const file of [
    'radar-dashboard.tsx',
    'source-manager.tsx',
    'operations-dashboard.tsx',
    'governance-dashboard.tsx',
    'automation-console.tsx',
    'attention-inbox.tsx',
    'diagnostics-panel.tsx',
  ]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /width="/, `${file} 应使用默认页面宽度，只有项目工作台是例外`);
  }
});
