import { AttentionInbox } from '@/components/attention-inbox';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 待办' };

export default function InboxPage() {
  return <AttentionInbox />;
}
