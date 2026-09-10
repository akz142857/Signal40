/**
 * 只有两个宽度：普通页面和项目工作台。
 *
 * 过去还有一个 `standard`，写了 `width="wide"` 的页面（雷达、来源、治理）比没写的
 * （自动化、待办、运营、系统）宽一档，同一套导航下内容边界逐页跳动。
 * 少一个 token 就少一类漂移——要加新宽度前先问清楚它凭什么是独立层级。
 */
export type PageWidth = 'page' | 'workspace';

/** 全局应用条独立于页面宽度：导航固定在窗口右上角，不跟着内容 width 左右跳。 */
export const APP_BAR_WIDTH_CLASS = 'max-w-[1600px]';

export const PAGE_WIDTH_CLASSES: Record<PageWidth, string> = {
  page: 'max-w-7xl',
  workspace: 'max-w-[1500px]',
};

/** 桌面端和移动端共用的唯一一级信息架构。 */
export const GLOBAL_NAVIGATION = [
  { href: '/', label: '雷达' },
  { href: '/sources', label: '来源' },
  { href: '/automation', label: '自动化' },
  { href: '/inbox', label: '待办' },
  { href: '/operations', label: '运营' },
  { href: '/governance', label: '治理' },
  { href: '/settings/diagnostics', label: '系统' },
] as const;

export function navigationPathIsActive(pathname: string, href: string) {
  return href === '/'
    ? pathname === '/' || pathname.startsWith('/projects/')
    : pathname === href || pathname.startsWith(`${href}/`);
}
