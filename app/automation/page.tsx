import { AutomationConsole } from '@/components/automation-console';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 自动化控制台' };

export default function AutomationPage() {
  return <AutomationConsole />;
}
