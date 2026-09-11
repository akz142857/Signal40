import { DiagnosticsPanel } from '@/components/diagnostics-panel';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 系统自检' };

export default function DiagnosticsPage() {
  return <DiagnosticsPanel />;
}
