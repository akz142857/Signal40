import { RadarDashboard } from '@/components/radar-dashboard';
import { loadLatestTopics } from '@/lib/persistence';
import { db } from '@/lib/runtime';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Signal 40 · 选题雷达' };

// 首页读数据库，不做预渲染：空库就该是空列表。
// 这里曾经直接用 lib/sample-data 的示例数据当初始话题，导致全新部署的首页
// 也会渲染三条看起来像真的选题——对一个以证据完整性为前提的系统，
// 分不清真假数据比没有数据危险得多。
export const dynamic = 'force-dynamic';

export default async function Home() {
  const { topics } = await loadLatestTopics(db);
  return <RadarDashboard initialTopics={topics} />;
}
