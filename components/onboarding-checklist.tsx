import Link from 'next/link';
import { Circle, CircleCheck, CircleDot, TriangleAlert } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import type { OnboardingStep } from '@/lib/onboarding';
import { cn } from '@/lib/utils';

/**
 * 上手清单。
 *
 * 空首页原本只说「尚无已保存运行」，把「为什么空」和「现在该谁动手」都留给用户猜；
 * 而这条流水线每一步都有门禁，猜错就是一路撞墙。这里正着把状态讲一遍，
 * 全部完成后整块消失——它是引导，不是常驻装饰。
 */

const STEP_PRESENTATION = {
  done: { icon: CircleCheck, className: 'text-chart-1', label: '已完成' },
  current: { icon: CircleDot, className: 'text-foreground', label: '进行中' },
  blocked: { icon: TriangleAlert, className: 'text-chart-3', label: '受阻' },
  locked: { icon: Circle, className: 'text-muted-foreground', label: '未解锁' },
} as const;

export function OnboardingChecklist({ steps }: { steps: OnboardingStep[] }) {
  return (
    <section
      aria-label="上手清单"
      className="mb-5 rounded-2xl border border-border bg-card p-5"
    >
      <h2 className="text-sm font-semibold">接入到出选题还差这几步</h2>
      <ol className="mt-4 grid gap-3">
        {steps.map((step, index) => {
          const presentation = STEP_PRESENTATION[step.status];
          const Icon = presentation.icon;
          return (
            <li key={step.key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
              <Icon
                className={cn('mt-0.5 size-4 shrink-0', presentation.className)}
                aria-label={presentation.label}
              />
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-sm font-medium',
                    step.status === 'locked' && 'text-muted-foreground',
                  )}
                >
                  {index + 1}. {step.title}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
                {step.action && (
                  <Link
                    href={step.action.href}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'sm' }),
                      'mt-2',
                    )}
                  >
                    {step.action.label}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
