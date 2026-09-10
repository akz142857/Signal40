/**
 * 全站唯一的内容宽度。
 *
 * 这里曾经有 standard/wide/workspace 三个 token：写了 wide 的页面比没写的宽一档，
 * 应用条又比两者都宽，于是导航、页面标题和内容的左右边界三条线各走各的。
 * 宽度不是页面自己的选择——同一个产品里它就该是同一条线。要放宽就整体放宽。
 */
export const PAGE_WIDTH_CLASS = 'max-w-7xl';

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
