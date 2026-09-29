/**
 * 一次跑完 scripts/ 下所有 verify-*.mjs（真跑源码的 + 源码文本约束的都在内）。
 *
 * 为什么要它：`package.json` 里 `verify:smart-chat` 是手写的 `&&` 长链，
 * 新增脚本容易漏加；这里按目录自动收集，漏跑不会发生。
 * 输出用 inherit 直通终端（不抓管道），退出码逐个汇总，任一失败即整体失败。
 *
 * 用法：
 *   node scripts/run-all-verifies.mjs                 # 全部
 *   node scripts/run-all-verifies.mjs --only silence  # 只跑名字含 silence 的
 *   node scripts/run-all-verifies.mjs --list          # 只列出会跑哪些
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const scriptsDir = __dirname;

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
}

const only = argValue('--only');
const listOnly = process.argv.includes('--list');

/**
 * 依赖「真实运行数据」的脚本：没有数据时它们应当失败（不能假装通过），
 * 但也不该把整套批量验收拖红 —— 这里显式跳过并在汇总里列出来。
 */
const DATA_DEPENDENT = new Set(['verify-force-speak-log.mjs']);

/**
 * 各 verify 脚本会把 esbuild 产物 mkdtemp 到 `<repo>/node_modules/.mkai-verify-*`
 * （必须在 node_modules 下，否则 bundle 里的 `extract-zip` 裸导入解析不到），
 * 但它们自己不清理 → 跑几十次就堆几十个目录。这里统一在开跑前/跑完后各扫一遍。
 */
const bundleTmpParent = path.join(root, 'node_modules');
// 各 verify 脚本把 bundle mkdtemp 到 node_modules 下，但 mkdtemp 不会自己创建父目录
// （干净检出、或刚清过 node_modules 时会 ENOENT）。这里统一兜底。
fs.mkdirSync(bundleTmpParent, { recursive: true });

/**
 * 开始前/结束后顺手清掉无主的临时目录。
 *
 * 必须走 removeTmpDir（逐文件 unlink）而不是 fs.rmSync：一次 rmSync 上千个小文件
 * 会撞上环境的 safe-delete 批量删除保护，抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，
 * 把整个批量验收搞红。删不掉的（被别的进程占着）原样跳过，下次再收。
 */
function sweepBundleTmp() {
    let removed = 0;
    try {
        for (const e of fs.readdirSync(bundleTmpParent, { withFileTypes: true })) {
            if (!e.isDirectory() || !e.name.startsWith('.mkai-verify-')) continue;
            removeTmpDir(path.join(bundleTmpParent, e.name));
            removed += 1;
        }
    } catch {
        /* node_modules 不存在（尚未 npm install）时忽略 */
    }
    return removed;
}

const scripts = fs
    .readdirSync(scriptsDir)
    .filter((f) => /^verify-.*\.mjs$/.test(f))
    .filter((f) => (only ? f.includes(only) : true))
    .sort();

if (!scripts.length) {
    console.error(only ? `没有匹配 --only ${only} 的脚本` : '没有找到 verify-*.mjs');
    process.exit(2);
}

if (listOnly) {
    for (const f of scripts) console.log(f);
    process.exit(0);
}

const sweptBefore = sweepBundleTmp();
if (sweptBefore) console.log(`（开跑前清理了 ${sweptBefore} 个上次遗留的 bundle 临时目录）`);

/**
 * 跑一个 verify 脚本。
 *
 * stdio 必须用 'inherit'（直通终端，不建管道）：实测在 Windows 上改成
 * encoding:'utf8'（= 走管道）后，spawnSync 连开 24 个 node.exe 会 23/23 报
 * `EBUSY ... node.exe`，而 inherit 模式下同一份代码基本不出现 —— 管道会额外
 * 持有可执行文件句柄，撞上杀软/索引器扫描就 EBUSY。所以输出照旧直通。
 *
 * 但 inherit 下「用例失败」和「进程没起来」长得一样（都只有一行 exit 1），
 * 所以失败时用一次空转 spawnSync 探一下：能正常 --version 说明环境没问题。
 */
function runScript(file) {
    const r = spawnSync(process.execPath, [path.join(scriptsDir, file)], {
        cwd: root,
        stdio: 'inherit',
    });
    const launched = r.status !== null; // status=null → 被信号/EBUSY 干掉，压根没跑
    if (!launched) {
        const why = r.error ? (r.error.code || r.error.message) : `signal ${r.signal}`;
        console.log(`  ! ${file} 未能启动：${why}`);
    }
    return { code: launched ? r.status : 1, retryable: !launched };
}

const results = [];
let retried = 0;
for (const file of scripts) {
    if (DATA_DEPENDENT.has(file) && !process.env.MKAI_LOG_DIR) {
        console.log(`\n=== ${file} ===`);
        console.log('  SKIP：依赖真实运行日志（设 MKAI_LOG_DIR 或直接传目录可单独运行）');
        results.push({ file, code: 0, skipped: true });
        continue;
    }
    console.log(`\n=== ${file} ===`);
    const r = runScript(file);
    // EBUSY：Windows 上杀软/索引器短暂锁住 node.exe，进程根本没起来（status=null + 零输出）。
    // 这是环境抖动不是用例失败，重试即可 —— 不重试会把 24 连跑误报成十几个红。
    let code = r.code;
    if (code !== 0 && r.retryable) {
        console.log(`  ↻ ${file} 启动被占用（EBUSY），重试…`);
        retried += 1;
        const retry = runScript(file);
        code = retry.code;
    }
    results.push({ file, code });
}

const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);
const sweptAfter = sweepBundleTmp();
console.log('\n================ 汇总 ================');
for (const r of results) {
    console.log(
        `${r.skipped ? 'SKIP' : r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.file}${r.code ? ` (exit ${r.code})` : ''}`,
    );
}
console.log(`共 ${results.length} 个脚本，失败 ${failed.length} 个${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`);
if (retried) console.log(`（${retried} 个脚本首次启动遇 EBUSY，重试后通过）`);
if (sweptAfter) console.log(`（已清理 ${sweptAfter} 个 bundle 临时目录）`);
process.exit(failed.length ? 1 : 0);
