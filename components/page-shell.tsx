'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Bot, DatabaseZap, Inbox, Menu, Radar, Settings, UsersRound } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { GLOBAL_NAVIGATION, navigationPathIsActive, PAGE_WIDTH_CLASSES, type PageWidth } from '@/lib/page-shell';
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

export function GlobalNavigation() {
  return (
    <>
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
    </>
  );
}

export function PageContainer({
  width = 'standard',
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('mx-auto w-full px-4 sm:px-7', PAGE_WIDTH_CLASSES[width], className)}>{children}</div>;
}

export function PageHeader({
  width = 'standard',
  icon,
  title,
  subtitle,
  actions,
}: {
  width?: PageWidth;
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="border-b border-border/80 bg-background/95">
      <PageContainer width={width} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold tracking-[-0.03em]">{title}</div>
            <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <GlobalNavigation />
          {actions}
        </div>
      </PageContainer>
    </header>
  );
}
