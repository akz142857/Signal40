export type PageWidth = 'standard' | 'wide' | 'workspace';

export const PAGE_WIDTH_CLASSES: Record<PageWidth, string> = {
  standard: 'max-w-6xl',
  wide: 'max-w-7xl',
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
