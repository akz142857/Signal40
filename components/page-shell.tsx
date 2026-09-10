'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Bot, DatabaseZap, Inbox, Menu, Radar, Settings, UsersRound } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useSession } from '@/hooks/use-session';
import { GLOBAL_NAVIGATION, navigationPathIsActive, PAGE_WIDTH_CLASS } from '@/lib/page-shell';
import { cn } from '@/lib/utils';

const navigationIcons = { '/': Radar, '/sources': DatabaseZap, '/automation': Bot, '/inbox': Inbox, '/operations': Activity, '/governance': UsersRound, '/settings/diagnostics': Settings } as const;

function NavigationLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="全站导航" className={mobile ? 'grid gap-2' : 'hidden items-center gap-1 lg:flex'}>
      {GLOBAL_NAVIGATION.map(({ href, label }) => {
        const Icon = navigationIcons[href];
        const active = navigationPathIsActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              buttonVariants({ variant: active ? 'secondary' : 'ghost', size: mobile ? 'default' : 'sm' }),
              mobile && 'justify-start',
            )}
          >
            <Icon />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 当前身份只在全局条上出现一次，紧挨品牌放在左侧：它回答“我现在是谁”，
 * 和右侧的“我要去哪一页”是两件事。本机开发的伪造身份必须显式标出来。
 */
function IdentityBadge() {
  const session = useSession();
  const label = session.actor
    ? `${session.actor.email} · ${session.actor.role}`
    : session.loading
      ? '读取身份…'
      : '未识别身份';
  return (
    <span className="hidden max-w-56 truncate rounded-full bg-secondary px-3 py-1.5 text-xs text-secondary-foreground xl:inline-block" title={label}>
      {label}
      {session.localRoleHeadersAllowed && '（本机）'}
    </span>
  );
}

/**
 * 全局应用条：品牌、全站导航、当前身份。
 *
 * 它挂在 `app/layout.tsx` 上，每个页面拿到的都是同一份——过去导航跟着 `PageHeader`
 * 走，品牌位被页面标题占用（首页写 Signal 40、来源页写“来源控制台”），
 * 导航还会随页面 width token 横向跳，换一页就像换了个产品。
 */
export function AppBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur">
      <div className={cn('mx-auto flex w-full items-center gap-4 px-4 py-3 sm:px-7', PAGE_WIDTH_CLASS)}>
        <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="Signal 40 首页">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Radar className="size-5" />
          </span>
          <span className="truncate text-base font-semibold tracking-[-0.03em]">Signal 40</span>
        </Link>
        <IdentityBadge />
        <div className="ml-auto flex items-center gap-2">
          <NavigationLinks />
          <div className="lg:hidden">
            <Sheet>
              <SheetTrigger render={<Button variant="outline" size="icon" aria-label="打开全站导航" />}>
                <Menu />
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Signal 40</SheetTitle>
                  <SheetDescription>选择工作区域</SheetDescription>
                </SheetHeader>
                <div className="px-4">
                  <NavigationLinks mobile />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  );
}

export function PageContainer({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full px-4 sm:px-7', PAGE_WIDTH_CLASS, className)}>{children}</div>;
}

/**
 * 页面标题区：只讲“这一页是什么、能在这一页做什么”。
 * 品牌和导航归 `AppBar`，这里不再重复，否则每页的左上角都在换身份。
 */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="border-b border-border/80 bg-background">
      <PageContainer className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-secondary-foreground">
            {icon}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-[-0.03em]">{title}</h1>
            <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
      </PageContainer>
    </div>
  );
}
