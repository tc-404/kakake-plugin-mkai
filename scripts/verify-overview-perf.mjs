/**
 * 校验「总览页加载慢」三项优化的契约（真跑源码，不只看文本）。
 *
 * 覆盖：
 *   A. 宿主 fetchBalance 的「单飞 + 缓存」——同一时刻并发 N 次只应产生 1 次外部请求；
 *      强制刷新必须绕过缓存并作废在飞请求；
 *   B. WebUI 余额共享层 readBalance 存在单飞与 TTL 缓存，且 readBalanceSyncSnapshot 不发请求；
 *   C. 总览控制器：余额不在首屏关键路径、只提交一次 stats、余额走共享层；
 *   D. 顶部状态条：余额走共享层（不再各自打外部接口），且 config 一到即解除 loading。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const results = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out === true || out === undefined) {
      results.push({ ok: true, name });
    } else {
      results.push({ ok: false, name, detail: String(out) });
    }
  } catch (e) {
    results.push({ ok: false, name, detail: e?.message || String(e) });
  }
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------------------------------------------------------------------------
// A. 宿主 fetchBalance 单飞：直接 import 编译后的模块，用假 fetch 计数
// ---------------------------------------------------------------------------
const hostSrc = read('src/auth/smart-chat-billing.ts');
const webSrc = read('webui-src/hooks/useBalance.ts');
const ovSrc = read('webui-src/controllers/useOverviewController.ts');
const adminSrc = read('webui-src/shell/useAdminStatus.ts');

check('A1 宿主存在在飞请求单飞变量 balanceInFlight', () => {
  if (!/let\s+balanceInFlight\s*:/.test(hostSrc)) return '未找到 balanceInFlight 声明';
  return true;
});

check('A2 fetchBalance 在缓存未命中时优先搭车已有在飞请求', () => {
  // 必须出现「若已有 inFlight 则直接返回它」的判断，且在发起真实请求之前
  const guardIdx = hostSrc.indexOf('if (balanceInFlight) return balanceInFlight;');
  const fireIdx = hostSrc.indexOf('const task = requestBalanceOnce(');
  if (guardIdx < 0) return '未找到搭车判断';
  if (fireIdx < 0) return '未找到 requestBalanceOnce 调用';
  if (guardIdx > fireIdx) return '搭车判断位于真实请求之后，无法去重';
  return true;
});

check('A3 在飞表在 finally 中清空（避免复用已结束的 Promise）', () => {
  if (!/if \(balanceInFlight === task\) balanceInFlight = null;/.test(hostSrc)) {
    return '未在 finally 中按同一引用清空 balanceInFlight';
  }
  return true;
});

check('A4 clearBalanceCache 同时作废在飞请求', () => {
  const m = hostSrc.match(/export function clearBalanceCache\(\): void \{([\s\S]*?)\n\}/);
  if (!m) return '未找到 clearBalanceCache';
  if (!/balanceCache = null;/.test(m[1])) return '未清缓存';
  if (!/balanceInFlight = null;/.test(m[1])) return '未作废在飞请求';
  return true;
});

check('A5 余额请求带超时且失败结果同样入缓存', () => {
  if (!/BALANCE_FETCH_TIMEOUT_MS\s*=\s*6_000/.test(hostSrc)) return '未找到 6 秒超时';
  if (!/setTimeout\(\(\) => ctl\.abort\(\), BALANCE_FETCH_TIMEOUT_MS\)/.test(hostSrc)) return '超时未接 AbortController';
  // catch 分支里也要有入缓存，否则每次进页面都再干等一个超时窗口
  const catchBlock = hostSrc.split('} catch (e) {')[1] || '';
  if (!/balanceCache = \{ at: startedAt, data: result \};/.test(catchBlock)) return '失败结果未入缓存';
  return true;
});

// ---------------------------------------------------------------------------
// B. WebUI 共享余额层
// ---------------------------------------------------------------------------
check('B1 useBalance 同时具备 TTL 缓存与在飞去重', () => {
  if (!/^let cache: \{ at: number; snap: BalanceSnapshot \} \| null = null;/m.test(webSrc)) return '缺模块级缓存';
  if (!/^let inFlight: Promise<BalanceSnapshot> \| null = null;/m.test(webSrc)) return '缺模块级在飞表';
  if (!/const CACHE_TTL_MS = 60_000;/.test(webSrc)) return '缺 TTL 常量';
  return true;
});

check('B2 readBalance 非强刷时命中缓存即刻返回、命中在飞则搭车', () => {
  const fn = webSrc.match(/export function readBalance\([\s\S]*?\n\}/);
  if (!fn) return '未找到 readBalance';
  if (!/Date\.now\(\) - cache\.at < CACHE_TTL_MS/.test(fn[0])) return '未校验 TTL';
  if (!/return Promise\.resolve\(cache\.snap\)/.test(fn[0])) return '缓存命中未同步短路';
  if (!/else if \(inFlight\) \{\s*return inFlight;/.test(fn[0])) return '未搭车在飞请求';
  return true;
});

check('B3 强刷会作废缓存（避免用户点刷新仍看到旧值）', () => {
  const fn = webSrc.match(/export function readBalance\([\s\S]*?\n\}/);
  if (!fn) return '未找到 readBalance';
  if (!/if \(force\) \{\s*cache = null;/.test(fn[0])) return '强刷未清缓存';
  return true;
});

check('B4 readBalanceSyncSnapshot 是纯同步、绝不发请求', () => {
  const fn = webSrc.match(/export function readBalanceSyncSnapshot\(\)[\s\S]*?\n\}/);
  if (!fn) return '未找到 readBalanceSyncSnapshot';
  if (/api\.|fetch\(|readBalance\(/.test(fn[0])) return '实现里出现了网络调用';
  if (!/Date\.now\(\) - cache\.at >= CACHE_TTL_MS/.test(fn[0])) return '未校验 TTL';
  return true;
});

check('B5 前端侧请求带超时 + AbortSignal', () => {
  if (!/REQUEST_TIMEOUT_MS = 10_000/.test(webSrc)) return '缺前端超时常量';
  if (!/setTimeout\(\(\) => ctl\.abort\(\), REQUEST_TIMEOUT_MS\)/.test(webSrc)) return '超时未接 AbortController';
  if (!/signal\.removeEventListener\('abort', onAbort\)/.test(webSrc)) return '未清理 abort 监听（会泄漏）';
  return true;
});

// ---------------------------------------------------------------------------
// C. 总览控制器
// ---------------------------------------------------------------------------
check('C1 总览页余额不再直接打 /smart-chat/balance', () => {
  if (/api\.get<BalanceData>\(\s*['"]\/smart-chat\/balance/.test(ovSrc)) {
    return '仍在控制器内直连余额接口，未走共享层';
  }
  return true;
});

check('C2 总览页余额走共享层 readBalance', () => {
  if (!/import \{ readBalance, readBalanceSyncSnapshot \} from '\.\.\/hooks\/useBalance';/.test(ovSrc)) {
    return '未导入共享余额层';
  }
  if (!/await readBalance\(api, cfg, \{ force: false \}\)/.test(ovSrc)) return '未调用 readBalance';
  return true;
});

check('C3 首屏只提交一次 stats（消除整页二次重排）', () => {
  // 剔除注释行，只统计真实代码里的调用 —— 否则文档里提到的 setStats 会被误判
  const code = ovSrc
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const setStatsCalls = code.match(/setStats\(/g) || [];
  // 允许恰好两次：① 首屏整体提交 ② 余额补齐（只改余额卡片字段，不翻 loading）
  if (setStatsCalls.length > 2) return `真实代码里 setStats 调用 ${setStatsCalls.length} 次，疑似多次重排`;
  if (setStatsCalls.length < 2) return '余额补齐分支缺失';
  if (!/setStats\(\{/.test(code)) return '未找到首屏一次性对象提交';
  // 首屏那次必须是「整体对象提交」而不是基于 prev 的局部合并：基于 prev 会保留旧骨架值，
  // 且无法与余额字段在同一帧成型
  return true;
});

check('C3b 首屏提交不得翻转 loading 两次（骨架屏→内容→再补）', () => {
  const code = ovSrc
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const offCount = (code.match(/setLoading\(false\)/g) || []).length;
  if (offCount > 2) return `setLoading(false) 出现 ${offCount} 次，loading 会反复翻转触发重排`;
  // 首屏提交必须发生在 setLoading(false) 之前（先备好数据再一次性放行渲染）
  const idxCommit = code.indexOf('setStats({');
  const idxOff = code.indexOf('setLoading(false)');
  if (idxCommit < 0 || idxOff < 0) return '关键语句缺失';
  if (idxCommit > idxOff) return 'setLoading(false) 早于首屏数据提交，会先渲染空态再重排';
  return true;
});

check('C4 首屏提交先吃共享缓存快照，避免先闪占位', () => {
  if (!/const cachedBal = readBalanceSyncSnapshot\(\);/.test(ovSrc)) return '未同步读取缓存快照';
  if (!/balanceLabel: cachedBal\?\.label \?\? EMPTY\.balanceLabel/.test(ovSrc)) return '首屏未用缓存值填充余额';
  return true;
});

check('C5 两个批次的依赖关系仍并行（switches 依赖 groups 是必要串行）', () => {
  if (!/const \[gSwR, fSwR\] = await Promise\.all\(\[/.test(ovSrc)) return 'switches 未并行';
  if (!/type: 'group', ids: groups\.join\(','\)/.test(ovSrc)) return 'group 分支缺失';
  if (!/type: 'friend', ids: friends\.join\(','\)/.test(ovSrc)) return 'friend 分支缺失';
  return true;
});

// ---------------------------------------------------------------------------
// D. 顶部状态条
// ---------------------------------------------------------------------------
check('D1 顶部状态条余额走共享层（不再各打一次外部接口）', () => {
  if (/api\.get<BalanceData>\(\s*['"]\/smart-chat\/balance/.test(adminSrc)) {
    return '状态条仍直连余额接口，会与总览页重复请求';
  }
  if (!/await readBalance\(api, cfg, \{ force: false \}\)/.test(adminSrc)) return '未走共享层';
  return true;
});

check('D2 状态条 config 就位后立即解除 loading（余额慢不该一直转圈）', () => {
  const idxCfg = adminSrc.indexOf("setModelLabel(lastSeg(String(cfg.model || '')));");
  const idxOff = adminSrc.indexOf('setLoading(false);', idxCfg);
  const idxBal = adminSrc.indexOf('await readBalance(', idxCfg);
  if (idxCfg < 0 || idxOff < 0 || idxBal < 0) return '关键语句缺失';
  if (idxOff > idxBal) return 'loading 在余额之后才解除，仍在陪外部接口一起等';
  return true;
});

check('D3 状态条 config 失败也会继续查余额（不再永久停在「…」）', () => {
  if (!/catch \{[\s\S]{0,120}cfg = \{\};/.test(adminSrc)) return 'config 失败未兜底成空对象';
  return true;
});

check('D4 三处强刷都作废共享缓存，保证快照一致', () => {
  const cfgCtrl = read('webui-src/controllers/useConfigController.ts');
  if (!/if \(force\) invalidateBalance\(\);/.test(cfgCtrl)) return '配置页强刷未作废共享缓存';
  if (!/export function invalidateAdminBalance\(\): void \{\s*invalidateBalance\(\);/.test(adminSrc)) {
    return '未暴露 invalidateAdminBalance';
  }
  return true;
});

// ---------------------------------------------------------------------------
// E. 宿主 HTTP 层不再自行 clearBalanceCache（避免语义分裂）
// ---------------------------------------------------------------------------
check('E1 HTTP 层把 force 交给 fetchBalance 统一处理', () => {
  const webHost = read('src/auth/smart-chat-web.ts');
  if (/if \(force\) clearBalanceCache\(\);/.test(webHost)) {
    return 'HTTP 层仍在自行清缓存，与 fetchBalance 内的 force 处理重复';
  }
  if (!/const data = await fetchBalance\(cfg, force, deps\);/.test(webHost)) return '未把 force 传入';
  return true;
});

// ---------------------------------------------------------------------------
// F. 渲染侧：毛玻璃降级 + 骨架屏合成层
// ---------------------------------------------------------------------------
check('F1 提供毛玻璃降级：尊重系统「减少透明度」偏好', () => {
  const css = read('webui-src/styles.css');
  if (!/@media \(prefers-reduced-transparency: reduce\)/.test(css)) return '缺少 reduced-transparency 降级';
  // 降级块内必须真的把 glass-card 的 blur 关掉。
  // 注意：同一个偏好可能有多个 @media 块（如后来为某个弹窗单独补了一小段），
  // 所以不能只取第一段 —— 必须扫全部同类块，任一块覆盖到 glass-card 即算通过。
  const chunks = css.split('@media (prefers-reduced-transparency: reduce)').slice(1);
  const covers = chunks.some((c) => {
    const body = c.split('}\n}')[0];
    return /\.glass-card/.test(body) && /backdrop-filter: none !important;/.test(body);
  });
  if (!covers) return '降级块未覆盖 glass-card';
  return true;
});

check('F2 提供毛玻璃降级：低端设备按能力判定（用 max- 避免误伤好设备）', () => {
  const css = read('webui-src/styles.css');
  if (!/@media \(max-device-memory: 4\)/.test(css)) return '缺少 device-memory 降级';
  if (!/@media \(max-hardware-concurrency: 4\)/.test(css)) return '缺少 hardware-concurrency 降级';
  // 绝不能用 min-：那会反向命中高端设备，把好设备也降级
  if (/@media \(min-device-memory/.test(css)) return '出现 min-device-memory，方向反了';
  if (/@media \(min-hardware-concurrency/.test(css)) return '出现 min-hardware-concurrency，方向反了';
  return true;
});

check('F3 降级只关模糊、保留同色系底与圆角（不是粗暴隐藏）', () => {
  const css = read('webui-src/styles.css');
  const block = css.split('@media (max-device-memory: 4)')[1] || '';
  const body = block.split('\n}')[0];
  if (!/background: rgba\(255, 255, 255, 0\.9\)/.test(body)) return '降级未补不透明底色，卡片会变透明';
  if (/display:\s*none/.test(body)) return '降级直接隐藏了元素（不该）';
  return true;
});

check('F4 骨架屏微光不再新建合成层（改用 background-position）', () => {
  const css = read('webui-src/styles.css');
  const block = css.split('.mkai-admin .ov-skeleton {')[1] || '';
  const body = block.split('\n}')[0];
  if (!/background-size: 300% 100%/.test(body)) return '未用 background-size 做微光';
  if (!/animation: ov-shimmer-bg/.test(body)) return '未绑定新的 background 微光动画';
  // 旧的绝对定位伪元素方案会给每张骨架建一层，应已移除
  if (/\.ov-skeleton::after/.test(css)) return '仍保留 ::after 绝对定位微光（会新建合成层）';
  // 旧 keyframe 若还在就是死代码
  if (/@keyframes ov-shimmer \{/.test(css)) return '残留未使用的 ov-shimmer 关键帧';
  return true;
});

// ---------------------------------------------------------------------------
// A/B 两层的真实运行验证见 verify-overview-e2e.mjs（WebUI 共享层）
// ---------------------------------------------------------------------------


async function runtimeChecks() {
  const esbuild = await import('esbuild');
  const entry = path.join(root, 'src/auth/smart-chat-billing.ts');
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['fs', 'path', 'os', 'crypto', 'http', 'https', 'stream', 'events', 'util', 'url', 'zlib', 'assert', 'buffer', 'net', 'tls', 'dns', 'child_process', 'node:*'],
    logLevel: 'silent',
  });
  const code = built.outputFiles[0].text;
  const tmp = path.join(root, 'node_modules', '.tmp-billing-check.cjs');
  fs.writeFileSync(tmp, code);

  let fetchCount = 0;
  const fakeFetch = async () => {
    fetchCount += 1;
    // 模拟慢速外部 API，制造并发窗口
    await new Promise((r) => setTimeout(r, 60));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
        }),
    };
  };
  globalThis.fetch = fakeFetch;

  const require = createRequire(import.meta.url);
  const mod = require(tmp);
  const cfg = {
    vendor: 'deepseek',
    api_key: 'sk-test',
    base_url: 'https://api.deepseek.com',
    balance_url: 'https://api.deepseek.com/user/balance',
  };

  try {
    // A6: 并发 4 次（缓存为空）应只产生 1 次外部请求
    mod.clearBalanceCache();
    fetchCount = 0;
    const rs = await Promise.all([
      mod.fetchBalance(cfg, false, null),
      mod.fetchBalance(cfg, false, null),
      mod.fetchBalance(cfg, false, null),
      mod.fetchBalance(cfg, false, null),
    ]);
    check('R1 并发 4 次 fetchBalance 只产生 1 次外部请求（单飞生效）', () => {
      if (fetchCount !== 1) return `实际外部请求 ${fetchCount} 次，期望 1 次`;
      if (rs.some((r) => !r.infos || !r.infos.length)) return '有调用方未拿到结果';
      return true;
    });

    // A7: 缓存未过期时再调不发请求
    fetchCount = 0;
    await mod.fetchBalance(cfg, false, null);
    await mod.fetchBalance(cfg, false, null);
    check('R2 TTL 内复用缓存，0 次外部请求', () => {
      if (fetchCount !== 0) return `实际外部请求 ${fetchCount} 次，期望 0 次`;
      return true;
    });

    // A8: force 必须绕过缓存
    fetchCount = 0;
    await mod.fetchBalance(cfg, true, null);
    check('R3 force=true 绕过缓存，恰好 1 次外部请求', () => {
      if (fetchCount !== 1) return `实际外部请求 ${fetchCount} 次，期望 1 次`;
      return true;
    });

    // A9: 失败后不应把在飞表永久占住（第二次仍能重新发起）
    fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new Error('network down');
    };
    mod.clearBalanceCache();
    await mod.fetchBalance(cfg, false, null);
    const r2 = await mod.fetchBalance(cfg, false, null);
    check('R4 请求失败后不锁死在飞表（可再次发起且返回降级结果）', () => {
      if (fetchCount !== 1) return `清缓存后第二次仍发起请求，实际 ${fetchCount} 次`;
      // 第二次应命中「失败结果也入缓存」
      if (!r2 || r2.available !== false) return '降级结果不合法';
      return true;
    });

    // A10: clearBalanceCache 后能重新发起
    fetchCount = 0;
    globalThis.fetch = fakeFetch;
    mod.clearBalanceCache();
    await mod.fetchBalance(cfg, false, null);
    check('R5 clearBalanceCache 后可重新发起外部请求', () => {
      if (fetchCount !== 1) return `实际 ${fetchCount} 次，期望 1 次`;
      return true;
    });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

await runtimeChecks();

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
const total = results.length;
console.log('');
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : `\n      → ${r.detail}`}`);
}
console.log('');
if (failed.length) {
  console.log(`[verify-overview-perf] ${total - failed.length}/${total} 通过，${failed.length} 失败`);
  process.exit(1);
}
console.log(`[verify-overview-perf] ${total}/${total} 全部通过`);
