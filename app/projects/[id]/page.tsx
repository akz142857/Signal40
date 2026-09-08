import { db } from '@/lib/runtime';
import Link from 'next/link';
import { ProjectWorkspace } from '@/components/workspace/project-workspace';
import { loadContentProject } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await loadContentProject(db, id);
  if (!project) return <main className="grid min-h-screen place-items-center bg-background p-6"><div className="text-center"><h1 className="text-2xl font-semibold">项目不存在</h1><Link href="/" className="mt-4 inline-block text-sm underline">返回选题雷达</Link></div></main>;
  return <ProjectWorkspace initialProject={project} />;
}
