import { RadarDashboard } from '@/components/radar-dashboard';
import { runPipeline } from '@/lib/domain';
import { sampleArticles } from '@/lib/sample-data';

export default function Home() {
  const now = new Date();
  return <RadarDashboard initialTopics={runPipeline(sampleArticles(now), now)} />;
}
