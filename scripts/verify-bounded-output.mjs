/**
 * A③ 有界输出 + spill 验收（行为级，加载真实源码）
 *
 * 覆盖：
 *   spillTextToScope   落在本群文件目录、强制 .txt、rel 标签格式、字节数
 *   取回闭环           spill → resolveSavedFile → 读回原文逐字一致（证明 mkapi_002 真能读到）
 *   buildSpillHint     指引必须带上文件名与 mkapi_002 op="read" 的照做参数
 *   上限截断           超大内容按 SPILL_MAX_BYTES 截断并标记
 *   无 scope           私聊（无群号）必须拒绝，交给调用方退回截断
 *   boundToolOutput    超阈值才落盘；没落盘成功时退回老口径（不再丢失整段）
 *
 * 运行：node scripts/verify-bounded-output.mjs
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-spill-'));

async function loadModule(relTsPath) {
    const outfile = path.join(tmpDir, `${path.basename(relTsPath, '.ts')}.mjs`);
    await build({
        entryPoints: [path.join(root, relTsPath)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        logLevel: 'silent',
        external: ['extract-zip'],
    });
    return import(`file://${outfile.replace(/\\/g, '/')}`);
}

const fileMod = await loadModule('src/auth/smart-chat-file.ts');
const toolsMod = await loadModule('src/auth/smart-chat-tools.ts');

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mkai-spill-'));
const SCOPE = '1082631686';
const deps = {
    readA: () => '',
    writeA: () => true,
    readB: () => null,
    writeB: () => true,
    getDataPath: () => dataPath,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
};

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

// ------------------------------------------------------------------ 落盘
const body = `第1行：${'内容'.repeat(2000)}\n第2行：END-标记\n`;
const spill = fileMod.spillTextToScope(deps, SCOPE, 'webfetch-abc.txt', body);
assert.strictEqual(spill.ok, true, `落盘应成功，实际 ${spill.error}`);
assert.strictEqual(spill.name, 'webfetch-abc.txt', '保留白名单后缀 .txt');
assert.strictEqual(spill.rel, `群文件/${SCOPE}/webfetch-abc.txt`, `rel 标签格式（实际 ${spill.rel}）`);
assert.ok(
    fs.existsSync(path.join(dataPath, '筱筱吖/扩展功能/智能对话/群文件', SCOPE, 'webfetch-abc.txt')),
    '文件必须落在本群文件目录',
);
ok('spillTextToScope：落本群文件目录、.txt、rel 标签正确');

// 后缀改写：非白名单后缀也强制成 .txt（否则 mkapi_002 读不了）
const spill2 = fileMod.spillTextToScope(deps, SCOPE, 'report.json', 'x'.repeat(100));
assert.strictEqual(spill2.name, 'report.txt', '非白名单后缀强制改 .txt');
ok('spill 强制 .txt（保证 mkapi_002 的白名单能读）');

// ------------------------------------------------------ 取回闭环（关键）
const back = fileMod.resolveSavedFile(deps, SCOPE, spill.name);
assert.strictEqual(back.ok, true, `resolveSavedFile 应能按名字找到（${back.error}）`);
const readBack = fs.readFileSync(back.abs, 'utf8');
assert.strictEqual(readBack, body, '读回的原文必须逐字一致（mkapi_002 读得到的证明）');
assert.strictEqual(
    fileMod.listSavedFiles(deps, SCOPE, 10).some((r) => r.name === spill.name),
    true,
    'mkapi_002 op="list" 也应能列出它',
);
ok('取回闭环：spill → resolveSavedFile/listSavedFiles → 原文逐字一致');

// ------------------------------------------------------------------ 指引
const hint = fileMod.buildSpillHint(spill, { kind: '网页正文', omittedChars: 1234 });
assert.ok(hint.includes(spill.rel), '指引要给出落盘位置');
assert.ok(hint.includes('mkapi_002'), '指引要给出取回方式');
assert.ok(hint.includes(`name="${spill.name}"`), '指引要给出可直接照做的 name 参数');
assert.ok(/offset/.test(hint), '指引要说明读不完用 offset 续读');
assert.ok(hint.includes('1234'), '指引要说明省略了多少字');
ok('buildSpillHint：位置 + 照做参数（name/offset）+ 省略量');

// ------------------------------------------------------------ 上限截断
const huge = 'x'.repeat(fileMod.SPILL_MAX_BYTES + 100_000);
const spill3 = fileMod.spillTextToScope(deps, SCOPE, 'huge.txt', huge);
assert.strictEqual(spill3.ok, true);
assert.strictEqual(spill3.truncated, true, '超上限必须标记 truncated');
assert.ok(spill3.bytes <= fileMod.SPILL_MAX_BYTES + 200, `落盘字节要收口（${spill3.bytes}）`);
ok('超上限按 SPILL_MAX_BYTES 截断并标记');

// ------------------------------------------------------------ 无 scope
const noScope = fileMod.spillTextToScope(deps, '', 'x.txt', 'abc');
assert.strictEqual(noScope.ok, false);
assert.strictEqual(noScope.error, 'no_scope', '私聊（无群号）必须拒绝，交给调用方退回截断');
ok('无群号拒绝落盘（私聊不误写）');

// --------------------------------------------------- boundToolOutput
const shortText = '短内容'.repeat(10);
assert.strictEqual(
    toolsMod.boundToolOutput(shortText, { spill: () => 'HINT' }, { name: 'x.txt', kind: 't' }),
    shortText,
    '未超阈值原样返回（不为几百字写文件）',
);
const longText = `HEAD-开头\n${'很长的正文'.repeat(2000)}\nTAIL-结尾`;
let spillCalled = 0;
const bounded = toolsMod.boundToolOutput(longText, {
    spill: (name, text, kind) => {
        spillCalled += 1;
        const s = fileMod.spillTextToScope(deps, SCOPE, name, text);
        return fileMod.buildSpillHint(s, { kind, omittedChars: text.length - 1500 });
    },
}, { name: 'web-1.txt', kind: '网页正文' });
assert.strictEqual(spillCalled, 1, '超阈值必须落盘一次');
assert.ok(bounded.length < longText.length, '给模型的必须是有界内容');
assert.ok(bounded.includes('HEAD-开头'), '要保留头部（模型先看到开头才可能追问）');
assert.ok(bounded.includes('mkapi_002'), '要带上取回指引');
assert.ok(!bounded.includes('TAIL-结尾'), '尾部不再整段塞进上下文');
const spilledFile = fileMod.resolveSavedFile(deps, SCOPE, 'web-1.txt');
assert.strictEqual(spilledFile.ok, true, '落盘文件可被取回');
assert.ok(
    fs.readFileSync(spilledFile.abs, 'utf8').includes('TAIL-结尾'),
    '完整原文（含结尾）必须留在盘上',
);
ok('boundToolOutput：超阈值落盘 + 只回头部 + 指引；完整原文留在盘上');

// 没落盘成功 → 退回老口径（截 12000，不把整段丢掉）
const fallback = toolsMod.boundToolOutput(longText, { spill: () => '' }, { name: 'x.txt', kind: 't' });
assert.ok(fallback.length <= 12000, '落盘失败时退回 12000 字截断');
assert.ok(fallback.startsWith('HEAD-开头'), '退回时仍保留头部');
ok('落盘失败退回老口径（不整段丢失）');

// 接线：flush 必须真的把 spill 回调挂上（否则工具层拿不到）
const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
assert.ok(flushSrc.includes('spillTextToScope'), 'flush 必须接线 spillTextToScope');
assert.ok(/spill: groupId/.test(flushSrc), '只有群聊（有群号）才挂 spill');
const toolsSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-tools.ts'), 'utf8');
assert.ok(
    (toolsSrc.match(/boundToolOutput\(/g) || []).length >= 3,
    'web_search 与 web_fetch 两条都要过 boundToolOutput',
);
ok('接线：flush 注入 spill（仅群聊），两条联网工具都过有界输出');

removeTmpDir(tmpDir);
removeTmpDir(dataPath);
console.log(`\nverify-bounded-output: 全部通过（${n} 组断言）`);
