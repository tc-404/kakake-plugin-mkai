/**
 * 构建插件控制台远程模块 → webui/remote.js（宿主动态 import）
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'webui');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

await build({
  configFile: false,
  root,
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    sourcemap: false,
    target: 'esnext',
    minify: true,
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'webui-src/remote.tsx'),
      formats: ['es'],
      fileName: () => 'remote.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-router-dom',
      ],
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'remote.[ext]',
      },
    },
    outDir,
    cssCodeSplit: false,
  },
});

const cssPath = resolve(outDir, 'remote.css');
if (fs.existsSync(cssPath)) {
  console.log('[MK_AI build-webui] note: remote.css emitted (inline preferred)');
}

console.log('[MK_AI build-webui] webui/remote.js');

