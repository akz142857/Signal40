import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { VideoProjectV2 } from '../lib/project-v2.ts';

let serveUrlPromise: Promise<string> | null = null;

function getServeUrl() {
  if (!serveUrlPromise) {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    serveUrlPromise = bundle({ entryPoint: path.resolve(directory, '../video/index.ts'), webpackOverride: (config) => config });
  }
  return serveUrlPromise;
}

export async function renderProject(
  project: VideoProjectV2,
  outputLocation: string,
  options: { profile?: 'preview' | 'final' } = {},
) {
  const serveUrl = await getServeUrl();
  const inputProps = { project };
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || null;
  const composition = await selectComposition({ serveUrl, id: project.render.compositionId, inputProps, browserExecutable });
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation,
    inputProps,
    imageFormat: 'jpeg',
    jpegQuality: options.profile === 'preview' ? 72 : 88,
    crf: options.profile === 'preview' ? 30 : 18,
    pixelFormat: 'yuv420p',
    x264Preset: options.profile === 'preview' ? 'veryfast' : 'medium',
    concurrency: '50%',
    overwrite: true,
    enforceAudioTrack: true,
    browserExecutable,
  });
  return { outputLocation, composition: { id: composition.id, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames } };
}
