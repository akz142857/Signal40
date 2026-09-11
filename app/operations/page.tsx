import { OperationsDashboard } from '@/components/operations-dashboard';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 运行与 SLO' };

export default function OperationsPage() {
  return <OperationsDashboard />;
}
