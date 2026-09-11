import { GovernanceDashboard } from '@/components/governance-dashboard';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 治理' };

export default function GovernancePage() {
  return <GovernanceDashboard />;
}
