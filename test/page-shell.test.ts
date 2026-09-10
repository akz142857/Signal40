import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { GLOBAL_NAVIGATION, navigationPathIsActive, PAGE_WIDTH_CLASS } from '../lib/page-shell.ts';

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

void test('全站只有一条内容宽度线', () => {
  assert.equal(PAGE_WIDTH_CLASS, 'max-w-7xl');

  // 应用条、页面标题区、页面内容必须共用同一个常量，
  // 否则导航和内容的左右边界又会各走各的。
  const shell = readFileSync(new URL('../components/page-shell.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /PAGE_WIDTH_CLASSES|APP_BAR_WIDTH_CLASS|PageWidth/, '外壳不应再有多个宽度 token');
  assert.equal(shell.match(/PAGE_WIDTH_CLASS/g)?.length, 3, '应用条与页面容器都要引用同一个宽度常量');
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
    'workspace/project-workspace.tsx',
  ]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /width="/, `${file} 不应自己声明内容宽度`);
  }
});

/** 页面组件（不含 components/ui 的通用原语）。 */
function pageComponentSources() {
  const root = new URL('../components/', import.meta.url);
  const files: Array<[string, string]> = [];
  const walk = (dir: URL, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'ui') walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.tsx')) {
        files.push([`${prefix}${entry.name}`, readFileSync(new URL(entry.name, dir), 'utf8')]);
      }
    }
  };
  walk(root, '');
  return files;
}

/**
 * 标题层级只有一条硬规则：页面里任何标题都不能比页面标题（PageHeader 的 h1，text-xl）更大。
 * 之前运营页的“作业健康度”是 text-3xl、来源页的分区标题是 text-2xl，
 * 比页面自己的名字还醒目，一眼看过去分不清哪层是哪层。
 */
void test('页面内标题不得大于页面标题', () => {
  for (const [name, source] of pageComponentSources()) {
    for (const heading of source.match(/<h[1-6] className="[^"]*"/g) ?? []) {
      assert.doesNotMatch(heading, /text-(?:2xl|3xl|4xl|5xl)/, `${name} 的标题字号越过了页面标题：${heading}`);
    }
  }
});

void test('页面容器使用同一档纵向间距', () => {
  for (const [name, source] of pageComponentSources()) {
    for (const container of source.match(/<PageContainer className="[^"]*"/g) ?? []) {
      for (const padding of container.match(/\bpy-\d+/g) ?? []) {
        assert.equal(padding, 'py-6', `${name} 的页面容器间距应为 py-6：${container}`);
      }
    }
  }
});
