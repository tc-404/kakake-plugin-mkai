import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { KAKAKE_PLUGIN_NAME } from './scripts/plugin-constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, KAKAKE_PLUGIN_NAME);

const nodeModules = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
].flat();

function copyDirRecursive(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function copyPluginAssetsPlugin() {
  return {
    name: 'copy-mkai-assets',
    writeBundle() {
      for (const d of ['webui', 'assets', 'data']) {
        const src = resolve(__dirname, d);
        if (fs.existsSync(src)) {
          copyDirRecursive(src, resolve(OUT_DIR, d));
          console.log(`[MK_AI] ${d}/ → ${OUT_DIR}/${d}`);
        }
      }

      const pluginJson = resolve(__dirname, 'plugin.json');
      if (fs.existsSync(pluginJson)) {
        fs.copyFileSync(pluginJson, resolve(OUT_DIR, 'plugin.json'));
      }

      const pkgPath = resolve(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const distPkg: Record<string, unknown> = {
          name: pkg.name,
          plugin: pkg.plugin,
          version: pkg.version,
          type: pkg.type,
          main: pkg.main,
          description: pkg.description,
          author: pkg.author,
          license: pkg.license,
        };
        if (pkg.webuiModule) distPkg.webuiModule = pkg.webuiModule;
        if (pkg.dependencies) distPkg.dependencies = pkg.dependencies;
        fs.writeFileSync(resolve(OUT_DIR, 'package.json'), `${JSON.stringify(distPkg, null, 2)}\n`);
      }
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    sourcemap: false,
    target: 'esnext',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: [...nodeModules],
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: OUT_DIR,
    emptyOutDir: true,
  },
  plugins: [nodeResolve(), copyPluginAssetsPlugin()],
});
