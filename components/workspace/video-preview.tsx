'use client';

import { Player } from '@remotion/player';
import type { VideoProjectV2 } from '@/lib/project-v2';
import { Signal40Video } from '@/video/Signal40Video';

export function VideoPreview({ project }: { project: VideoProjectV2 }) {
  return <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-2xl border border-border bg-black shadow-xl"><Player component={Signal40Video} inputProps={{ project }} durationInFrames={project.render.durationSeconds * project.render.fps} compositionWidth={project.render.width} compositionHeight={project.render.height} fps={project.render.fps} controls style={{ width: '100%', aspectRatio: `${project.render.width} / ${project.render.height}` }} /></div>;
}
