/**
 * 端到端验证「同一页面内两处消费者只产生一次外部余额请求」。
 *
 * 手法：用 esbuild 把 useBalance.ts 打成一个可在 node 里跑的 CJS 模块，
 * 注入计数版 fetch，模拟「顶部状态条 + 总览页同一帧挂载」的真实时序。
 *
 * 这是对 verify-overview-perf.mjs 里 R1 的补充：R1 验的是宿主层去重，
 * 这里验的是 WebUI 共享层去重，两层都成立才能保证外部 API 只被访问一次。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const esbuild = await import('esbuild');

// 造一个最小替身：真实项目里 useBalance 依赖 ../api 与 ../smartChatLogic，
// 这两个都很重，这里用 alias 把它们换成轻量桩，只测去重逻辑本身。
const stubApi = `
export const __calls = [];
export function createApi() {
  return {
    base: '',
    get: async (p, q, init) => {
      __calls.push({ p, q });
      await new Promise((r) => setTimeout(r, 50)); // 模拟网络往返，制造并发窗口
      return { code: 0, data: { available: true, infos: [{ currency: 'CNY', total_balance: '9.99' }] } };
    },
    post: async () => ({ code: 0, data: {} }),
  };
}
`;

const stubLogic = `
export function inferVendorFromConfig(cfg) { return cfg && cfg.vendor ? cfg.vendor : 'deepseek'; }
export function computeBalanceDisplay(vendor, info, data) {
  if (!info) return data && data.error ? String(data.error) : '';
  return info.total_balance || '';
}
export function computeBalanceBarPct() { return 50; }
`;

const entrySrc = `
import { readBalance, readBalanceSyncSnapshot, invalidateBalance } from '${path
  .join(root, 'webui-src/hooks/useBalance.ts')
  .replace(/\\/g, '/')}';
import { createApi, __calls } from '__stub_api__';

const api = createApi({ vendor: 'deepseek' }, async () => ({}));

export async function run() {
  invalidateBalance();
  __calls.length = 0;

  // 同一帧内两处消费者各请求一次 —— 正是顶部状态条 + 总览页的真实时序
  const [a, b] = await Promise.all([
    readBalance(api, { vendor: 'deepseek' }, {}),
    readBalance(api, { vendor: 'deepseek' }, {}),
  ]);

  const afterConcurrent = __calls.length;

  // 再来一次：应完全命中缓存，0 网络请求
  readBalanceSyncSnapshot();
  const beforeCached = __calls.length;
  await readBalance(api, { vendor: 'deepseek' }, {});
  const cachedDelta = __calls.length - beforeCached;

  // 强刷：应绕过缓存，恰好 1 次
  const beforeForce = __calls.length;
  await readBalance(api, { vendor: 'deepseek' }, { force: true });
  const forceDelta = __calls.length - beforeForce;

  return {
    afterConcurrent,
    cachedDelta,
    forceDelta,
    sameLabel: a.label === b.label,
    label: a.label,
    pct: a.pct,
    tone: a.tone,
  };
}
`;

const stubDir = path.join(root, 'node_modules', '.mkai-balance-stubs');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'api.ts'), stubApi);
fs.writeFileSync(path.join(stubDir, 'logic.ts'), stubLogic);
fs.writeFileSync(path.join(stubDir, 'entry.ts'), entrySrc);

const built = await esbuild.build({
  entryPoints: [path.join(stubDir, 'entry.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /^__stub_api__$/ }, () => ({ path: path.join(stubDir, 'api.ts') }));
        build.onResolve({ filter: /smartChatLogic$/ }, () => ({ path: path.join(stubDir, 'logic.ts') }));
      },
    },
  ],
});

const outFile = path.join(stubDir, 'bundle.cjs');
fs.writeFileSync(outFile, built.outputFiles[0].text);

const require = createRequire(import.meta.url);
const mod = require(outFile);
const r = await mod.run();

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

check('同一帧两处消费者只产生 1 次网络请求', r.afterConcurrent === 1, `实际 ${r.afterConcurrent} 次`);
check('TTL 内复用缓存，增量请求数为 0', r.cachedDelta === 0, `实际新增 ${r.cachedDelta} 次`);
check('force=true 绕过缓存并恰好补 1 次请求', r.forceDelta === 1, `实际新增 ${r.forceDelta} 次`);
check('两处消费者拿到同一份派生结果', r.sameLabel === true, 'label 不一致');
check('派生的 label / pct / tone 均已算出', !!r.label && r.pct === 50 && r.tone === 'ok', JSON.stringify(r));

// 清理
try {
  fs.rmSync(stubDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log('');
for (const x of results) {
  console.log(`${x.ok ? '  ✓' : '  ✗'} ${x.name}${x.ok ? '' : `\n      → ${x.detail}`}`);
}
const failed = results.filter((x) => !x.ok);
console.log('');
if (failed.length) {
  console.log(`[verify-overview-e2e] ${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`);
  process.exit(1);
}
console.log(`[verify-overview-e2e] ${results.length}/${results.length} 全部通过`);
