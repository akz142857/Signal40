import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig({
  // Remotion Player is intentionally isolated behind a lazy route chunk.
  build: { chunkSizeWarningLimit: 800 },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  // 数据库与对象存储通过 lib/runtime.ts 直接用 Node 驱动连接，
  // 不再依赖 Cloudflare 的 D1/R2 绑定，因此这里不装 cloudflare()/sites() 插件。
  ssr: { external: ['pg', '@aws-sdk/client-s3'] },
  plugins: [vinext()],
});
