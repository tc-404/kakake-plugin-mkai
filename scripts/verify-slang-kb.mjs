import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const corpusRaw = JSON.parse(fs.readFileSync(path.join(root, 'src', 'auth', 'slang-corpus.json'), 'utf8'));
assert.ok(Number(corpusRaw?.version) >= 2, 'corpus version');
assert.ok(Array.isArray(corpusRaw?.entries) && corpusRaw.entries.length >= 1350, `corpus entries ${corpusRaw?.entries?.length}`);
for (const e of corpusRaw.entries) {
    assert.ok(String(e.t || '').trim(), 'term non-empty');
    assert.ok(String(e.d || '').trim().length >= 8, `def non-empty for ${e.t}`);
    assert.ok(Array.isArray(e.k) && (e.k.includes(e.t) || (e.b && e.k.length === 0)), `keys or boundary flag for ${e.t}`);
}
const dup = new Set();
for (const e of corpusRaw.entries) {
    const k = String(e.t).toLowerCase();
    assert.ok(!dup.has(k), `duplicate term ${e.t}`);
    dup.add(k);
}

const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-slang-'));
const outfile = path.join(tmpDir, 'slang.cjs');
await build({
    entryPoints: [path.join(root, 'src/auth/smart-chat-slang.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['extract-zip'],
});
const m = createRequire(import.meta.url)(outfile);

assert.ok(m.SLANG_CORPUS_COUNT >= 1350, `runtime count ${m.SLANG_CORPUS_COUNT}`);
assert.ok(m.SLANG_CORPUS_COUNT <= corpusRaw.entries.length, 'runtime filters bad rows');

const hit = m.selectSlangByHits('这也太city了吧，尊嘟假嘟啊，泰裤辣', 6);
assert.ok(hit.length >= 3, `multi-hit expected, got ${hit.length}`);
const names = hit.map((h) => h.title);
assert.ok(names.some((n) => n.includes('city不city')), `city hit via variant key: ${names.join('|')}`);
assert.ok(names.some((n) => n.includes('尊嘟假嘟')), `zzjd hit: ${names.join('|')}`);
for (const h of hit) {
    assert.strictEqual(h.kind, 'lore', 'kind lore');
    assert.ok(h.id.startsWith('slang_'), 'id prefix');
    assert.ok(String(h.content).length >= 8, 'content present');
}

const bounded = m.selectSlangByHits('经典不愧是经典，但他刚才那波操作真是典中典，我直接蚌埠住了', 6);
const boundedNames = bounded.map((h) => h.title).join('|');
assert.ok(boundedNames.includes('蚌'), `boundary hit 蚌: ${boundedNames}`);
assert.ok(!boundedNames.includes('「典」'), `裸"典"在"经典"里不得误命中: ${boundedNames}`);
const singleHit = m.selectSlangByHits('好家伙，这下真急了', 6);
assert.ok(singleHit.map((h) => h.title).join('|').includes('急'), 'boundary single-char 急 hit');

assert.deepStrictEqual(m.selectSlangByHits('今天中午吃了碗牛肉面', 6), [], 'unrelated text no hit');
assert.deepStrictEqual(m.selectSlangByHits('', 6), [], 'empty query');
const inWord = m.selectSlangByHits('今天炒了个红烧肉，还夸了厨子，真棒', 6);
assert.ok(!inWord.map((h) => h.title).join('|').includes('「肉」'), '词内单字不得误命中');
const bare = m.selectSlangByHits('肉 狐 夸 振 综', 6);
assert.ok(bare.map((h) => h.title).join('|').includes('「肉」'), '裸单字黑话应命中');

const capped = m.selectSlangByHits('尊嘟假嘟 city 泰裤辣 白人饭 边界感 显眼包 搭子 挖呀挖 yyds 栓Q 摆烂 寄了', 3);
assert.ok(capped.length <= 3, `cap respected, got ${capped.length}`);

const lore = (() => {
    const blob = hit.map((h) => `◆ ${h.title}\n${h.content}`).join('\n\n');
    return `<lorebook>\n（本轮关键词命中；相关再用，别背全本）\n${blob}\n</lorebook>`;
})();
assert.ok(lore.includes('<lorebook>'), 'lorebook shell');
assert.ok(lore.includes('黑话「'), 'slang title rendered');

const t0 = Date.now();
for (let i = 0; i < 20; i++) {
    m.selectSlangByHits('这是一段完全不相关的普通群聊文本，用来测检索性能表现如何', 6);
}
const perCall = (Date.now() - t0) / 20;
assert.ok(perCall < 25, `scan too slow: ${perCall.toFixed(2)}ms/call`);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('verify-slang-kb: all passed');
