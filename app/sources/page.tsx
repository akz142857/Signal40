import { SourceManager } from '@/components/source-manager';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 来源控制台' };

export default function SourcesPage() {
  return <SourceManager />;
}
