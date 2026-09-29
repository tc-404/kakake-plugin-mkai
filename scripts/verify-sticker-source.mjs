/**
 * 校验「表情图库安装源可选」契约。
 *
 * 需求：点击安装时弹出悬浮窗，让用户选 GitHub 仓库 / kakake 服务器；GitHub 是新增源。
 *
 * 为什么不能只做文本断言：
 *  - 「源 id 收敛」有 4 条分支（空串 / 未知值 / 大小写 / 合法值），字符串匹配看不出对不对；
 *  - 「源 → URL 映射」必须逐图库对账，否则很容易把呆猫的地址配到菲比上；
 *  - 默认源必须保持 kakake —— 老调用方（不带 source）行为不能变，这是回归高发点。
 * 所以这里真跑 `smart-chat-sticker.ts` 的导出函数。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const results = [];
const check = (name, fn) => {
  try {
    const out = fn();
    results.push({
      ok: out === true || out === undefined,
      name,
      detail: out === true || out === undefined ? '' : String(out),
    });
  } catch (e) {
    results.push({ ok: false, name, detail: e?.message || String(e) });
  }
};

// ---------------------------------------------------------------------------
// 源码契约
// ---------------------------------------------------------------------------
const stickerSrc = read('src/auth/smart-chat-sticker.ts');
const webSrc = read('src/auth/smart-chat-web.ts');
const ctrlSrc = read('webui-src/controllers/useConfigController.ts');
const pageSrc = read('webui-src/pages/ConfigPage.tsx');
const cssSrc = read('webui-src/styles.css');

check('S1 后端定义 github 源且占用独立 id（不是复用 kakake）', () => {
  if (!/StickerSourceId = 'kakake' \| 'github'/.test(stickerSrc)) {
    return '未声明 StickerSourceId = kakake | github';
  }
  const ghCount = (stickerSrc.match(/id: 'github'/g) || []).length;
  if (ghCount < 2) return `github 源只出现 ${ghCount} 次（两个图库都该有）`;
  return true;
});

check('S2 两个 GitHub 直链与需求原文逐字一致', () => {
  const want = {
    daimao: 'https://github.com/tc-404/kakake-plugin-main/releases/download/111/daimao.zip',
    feibi: 'https://github.com/tc-404/kakake-plugin-main/releases/download/111/feibi.zip',
  };
  for (const [id, url] of Object.entries(want)) {
    if (!stickerSrc.includes(url)) return `${id} 的 GitHub 直链缺失：${url}`;
  }
  return true;
});

check('S3 默认源仍是 kakake（不带 source 的老调用行为不变）', () => {
  if (!/export const DEFAULT_STICKER_SOURCE: StickerSourceId = 'kakake';/.test(stickerSrc)) {
    return 'DEFAULT_STICKER_SOURCE 不是 kakake';
  }
  return true;
});

check('S4 HTTP 层透传 source，且三个字段名都接（source/mode/from）', () => {
  if (!/body\.source \|\| body\.mode \|\| body\.from/.test(webSrc)) {
    return 'HTTP 层未从 body 取 source/mode/from';
  }
  if (!/startStickerGalleryInstall\(deps, galleryId, source\)/.test(webSrc)) {
    return 'HTTP 层未把 source 传给 startStickerGalleryInstall';
  }
  return true;
});

check('S5 install 任务不再直接读 g.zipUrl（必须经 resolveStickerGalleryUrl）', () => {
  const fn = stickerSrc.match(/export async function startStickerGalleryInstall[\s\S]*?\n\}/);
  if (!fn) return '未找到 startStickerGalleryInstall';
  if (/downloadWithProgress\(\s*g\.zipUrl/.test(fn[0])) {
    return '仍在用 g.zipUrl 下载，选源会失效';
  }
  if (!/downloadWithProgress\(zipUrl,/.test(fn[0])) {
    return '未把解析后的 zipUrl 传给 downloadWithProgress';
  }
  return true;
});

check('S6 listStickerGalleriesStatus 返回 sources 与 defaultSource', () => {
  const fn = stickerSrc.match(/export function listStickerGalleriesStatus\(deps: SmartChatDeps\)[\s\S]*?\n\}/);
  if (!fn) return '未找到 listStickerGalleriesStatus';
  if (!/sources: listStickerSources\(\)/.test(fn[0])) return '未返回顶层 sources';
  if (!/defaultSource: DEFAULT_STICKER_SOURCE/.test(fn[0])) return '未返回 defaultSource';
  if (!/sources: g\.sources/.test(fn[0])) return '每个图库未返回自己的 sources';
  return true;
});

check('S7 前端有源选择弹层（ModalPortal + radiogroup）', () => {
  if (!/import \{ ModalPortal \} from '\.\.\/components\/ModalPortal';/.test(pageSrc)) {
    return 'ConfigPage 未引入 ModalPortal';
  }
  if (!/role="radiogroup"/.test(pageSrc)) return '弹层未用 radiogroup 语义';
  if (!/选择安装源/.test(pageSrc)) return '弹层标题缺失';
  return true;
});

check('S8 点安装一定先选源（installGallery 里 await pickStickerSource）', () => {
  if (!/const picked = pickStickerSource \? await pickStickerSource\(g\) : DEFAULT_STICKER_SOURCE;/.test(ctrlSrc)) {
    return 'installGallery 未先索取源';
  }
  if (!/if \(!picked\) return;/.test(ctrlSrc)) return '用户取消后未提前返回';
  return true;
});

check('S9 覆盖安装的确认文案带上了所选源（避免装错源不知情）', () => {
  if (!/源：\$\{stickerSourceLabel\(picked\)\}/.test(ctrlSrc)) {
    return '重新安装确认框未提示所选源';
  }
  return true;
});

check('S10 POST body 真的带上了 source', () => {
  if (!/source: picked,/.test(ctrlSrc)) return 'install 请求未带 source 字段';
  return true;
});

check('S11 弹层样式按主题实心卡片（不叠毛玻璃）', () => {
  if (!/\.mkai-admin \.sc-source-opt \{/.test(cssSrc)) return '缺少 .sc-source-opt 样式';
  if (!/\.mkai-admin \.sc-source-opt\.is-active/.test(cssSrc)) return '缺少选中态样式';
  return true;
});

// ---------------------------------------------------------------------------
// 真跑：源解析
// ---------------------------------------------------------------------------
const esbuild = await import('esbuild');
const built = await esbuild.build({
  entryPoints: [path.join(root, 'src/auth/smart-chat-sticker.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
});
const tmp = path.join(root, 'node_modules', '.tmp-sticker-source-verify.cjs');
fs.writeFileSync(tmp, built.outputFiles[0].text);
const m = createRequire(import.meta.url)(tmp);

const galleries = m.STICKER_GALLERIES;
const byId = (id) => galleries.find((g) => g.id === id);

check('R 图库清单仍只有 feibi / daimao，且 id 未改（改 id 会让已装用户重装）', () => {
  const ids = galleries.map((g) => g.id).sort();
  if (ids.join(',') !== 'daimao,feibi') return `实际 ${ids.join(',')}`;
  return true;
});

check('R 每个图库都恰好提供 kakake + github 两个源', () => {
  for (const g of galleries) {
    const ids = (g.sources || []).map((s) => s.id).sort();
    if (ids.join(',') !== 'github,kakake') return `${g.id} 的源是 ${ids.join(',') || '（空）'}`;
  }
  return true;
});

check('R 源 → 下载地址逐图库对账（呆猫/菲比不能串）', () => {
  const want = {
    feibi: {
      kakake: 'http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/AI图库/菲比.zip',
      github: 'https://github.com/tc-404/kakake-plugin-main/releases/download/111/feibi.zip',
    },
    daimao: {
      kakake: 'http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/AI图库/呆猫八条.zip',
      github: 'https://github.com/tc-404/kakake-plugin-main/releases/download/111/daimao.zip',
    },
  };
  for (const [gid, sources] of Object.entries(want)) {
    const g = byId(gid);
    if (!g) return `缺少图库 ${gid}`;
    for (const [sid, url] of Object.entries(sources)) {
      const got = m.resolveStickerGalleryUrl(g, sid);
      if (got !== url) return `${gid}/${sid} → ${got}，期望 ${url}`;
    }
  }
  return true;
});

check('R 默认源解析结果 === kakake 源（老行为零变化）', () => {
  if (m.DEFAULT_STICKER_SOURCE !== 'kakake') return `默认源是 ${m.DEFAULT_STICKER_SOURCE}`;
  for (const g of galleries) {
    const def = m.resolveStickerGalleryUrl(g, undefined);
    const kakake = m.resolveStickerGalleryUrl(g, 'kakake');
    if (def !== kakake) return `${g.id} 不传源得到 ${def}，与 kakake 的 ${kakake} 不一致`;
    if (def !== g.zipUrl) return `${g.id} 不传源没回到 g.zipUrl，破坏了兼容字段`;
  }
  return true;
});

check('R 非法/空源一律收敛成 kakake，绝不抛错', () => {
  const bad = ['', '   ', null, undefined, 'GITHUB_XXX', 'ftp', 'kakake2', 0, {}, []];
  for (const v of bad) {
    const got = m.normalizeStickerSource(v);
    if (got !== 'kakake') return `normalizeStickerSource(${JSON.stringify(v)}) = ${got}`;
  }
  return true;
});

check('R 合法源大小写/空白不敏感', () => {
  const cases = [
    ['github', 'github'],
    ['GitHub', 'github'],
    ['  GITHUB  ', 'github'],
    ['kakake', 'kakake'],
    ['KAKAKE', 'kakake'],
  ];
  for (const [input, expect] of cases) {
    const got = m.normalizeStickerSource(input);
    if (got !== expect) return `normalizeStickerSource(${JSON.stringify(input)}) = ${got}，期望 ${expect}`;
  }
  return true;
});

check('R 未知图库仍抛 unknown_gallery（不能让前端静默当成功）', () => {
  // 同步判定：函数是 async，这里只确认源码里有该分支（真跑需要造 deps，成本高）
  if (!/if \(!g\) \{\s*throw new Error\('unknown_gallery'\);/.test(stickerSrc)) {
    return '未知图库不再抛错，前端会拿到 undefined 当成功';
  }
  return true;
});

check('R 空地址源会被拦下（no_source_url），不发起空 URL 下载', () => {
  if (!/if \(!zipUrl\) \{\s*throw new Error\('no_source_url'\);/.test(stickerSrc)) {
    return '未拦截空 URL';
  }
  return true;
});

check('R sources 列表 UI 文案与后端一致（两处漂移会让用户困惑）', () => {
  const backend = m.listStickerSources().map((s) => `${s.id}:${s.label}`);
  const frontend = (ctrlSrc.match(/\{ id: 'kakake', label: '([^']+)'/g) || []).length
    + (ctrlSrc.match(/\{ id: 'github', label: '([^']+)'/g) || []).length;
  if (frontend !== 2) return `前端 STICKER_SOURCES 未定义满两个源（匹配到 ${frontend} 条）`;
  const beKakake = m.listStickerSources().find((s) => s.id === 'kakake')?.label;
  const beGithub = m.listStickerSources().find((s) => s.id === 'github')?.label;
  if (beKakake !== 'kakake 服务器') return `后端 kakake 文案异常：${beKakake}`;
  if (beGithub !== 'GitHub 仓库') return `后端 github 文案异常：${beGithub}`;
  if (!ctrlSrc.includes(`label: '${beKakake}'`)) return `前端未使用后端同款文案「${beKakake}」`;
  if (!ctrlSrc.includes(`label: '${beGithub}'`)) return `前端未使用后端同款文案「${beGithub}」`;
  if (backend.length !== 2) return `后端源数量 ${backend.length}`;
  return true;
});

check('R source 会写进安装进度（页面能显示"上次安装源"）', () => {
  if (!/source: sourceId,/.test(stickerSrc)) return '进度对象未记录 source';
  const fn = stickerSrc.match(/export interface StickerInstallProgress[\s\S]*?\n\}/);
  if (!fn) return '未找到 StickerInstallProgress';
  if (!/source\?: StickerSourceId;/.test(fn[0])) return '接口未声明可选 source';
  return true;
});

try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('');
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : `\n      → ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length) {
  console.log(`[verify-sticker-source] ${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`);
  process.exit(1);
}
console.log(`[verify-sticker-source] ${results.length}/${results.length} 全部通过`);
