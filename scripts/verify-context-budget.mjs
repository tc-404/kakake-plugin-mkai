/**
 * A① token 计量压缩 + A② 日志/表层分离 验收（行为级，加载真实源码）
 *
 * 覆盖：
 *   token 估算        CJK 与 ASCII 口径、消息开销、tool_calls 计入
 *   预算解析          默认比例、窗口来源（deepseek/nvidia/未知）、越界 clamp、写反兜正
 *   keepTailForTokens 保留预算与下限
 *   token 触发压缩    条数远不到 96，但估算超阈值 → 必须压（A① 的核心）
 *   条数硬阀          不传 budget 时行为与老版一致（96 条触发）
 *   影子日志          A②：被遮蔽原文留档、逐字可回放、有界 FIFO
 *   压缩台账          dropped/kept/tokens_before/prefix_invalid_from=messages[0]、epoch 递增
 *   前缀失效归因      recordSentApiPrefix 记 epoch；再压一次后 epoch 不等 → 可判定「刚压过」
 *
 * 运行：node scripts/verify-context-budget.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-budget-'));

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

const meter = await loadModule('src/auth/smart-chat-token-meter.ts');
const compact = await loadModule('src/auth/smart-chat-compact.ts');
const compose = await loadModule('src/auth/smart-chat-compose.ts');
const nvidiaCtx = await loadModule('src/auth/smart-chat-nvidia-context.ts');
const cfgMod = await loadModule('src/auth/smart-chat-config.ts');

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

// --------------------------------------------------------------- token 估算
assert.strictEqual(meter.estimateTextTokens(''), 0);
// 标定口径：CJK 0.65 token/字（真实 usage 实测 0.655）→ 4 个 CJK = ceil(2.6) = 3
assert.strictEqual(meter.estimateTextTokens('你好世界'), 3, 'CJK 按 0.65 token/字（标定值）');
assert.strictEqual(meter.estimateTextTokens('abcdefgh'), 2, 'ASCII 按 4 字符≈1 token');
assert.strictEqual(meter.estimateTextTokens('中'.repeat(100)), 65, '100 个汉字 ≈ 65 token');
assert.ok(
    meter.estimateTextTokens('中文 abc') >= 2,
    '混排应按两套口径分别累加',
);
const withTools = meter.estimateMessagesTokens([
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'read' } }] },
]);
const withoutTools = meter.estimateMessagesTokens([{ role: 'assistant', content: '' }]);
assert.ok(withTools > withoutTools, `tool_calls 必须计入（${withTools} > ${withoutTools}）`);
ok('token 估算：CJK/ASCII 口径 + 消息开销 + tool_calls');

// --------------------------------------------------------------- 预算解析
const dBudget = meter.resolveCompactionBudget(
    { vendor: 'deepseek', model: 'deepseek-v4-flash' },
);
assert.strictEqual(dBudget.window, 128_000, 'deepseek 按 128K 窗口');
assert.strictEqual(dBudget.thresholdTokens, 102_400, '阈值 = 窗口 × 0.8');
assert.strictEqual(dBudget.retainTokens, 20_480, '保留 = 窗口 × 0.16');
const nvBudget = meter.resolveCompactionBudget(
    { vendor: 'nvidia', model: 'deepseek-ai/deepseek-v4-flash-0731' },
    { nvidiaBudget: nvidiaCtx.nvidiaContextBudget('deepseek-ai/deepseek-v4-flash-0731') },
);
assert.strictEqual(nvBudget.source, 'vendor-model', 'nvidia 用档位表');
assert.strictEqual(
    nvBudget.thresholdTokens,
    Math.floor(nvidiaCtx.nvidiaContextBudget('deepseek-ai/deepseek-v4-flash-0731') * 0.8),
);
const unknown = meter.resolveCompactionBudget({ vendor: 'custom_x', model: 'm' });
assert.strictEqual(unknown.window, 64_000, '未知线路保守 64K');
assert.strictEqual(unknown.source, 'fallback');
const clamped = meter.resolveCompactionBudget({ compact_threshold_ratio: 2, compact_retain_ratio: -1 });
assert.strictEqual(clamped.thresholdRatio, 0.95, '阈值比例 clamp 到 0.95');
assert.strictEqual(clamped.retainRatio, 0.16, '非法保留比例回落默认');
const reversed = meter.resolveCompactionBudget({ compact_threshold_ratio: 0.5, compact_retain_ratio: 0.9 });
assert.ok(reversed.retainRatio < reversed.thresholdRatio, '写反必须兜正');
ok('预算解析：窗口来源 / 默认比例 / clamp / 兜正');

// ------------------------------------------------------- keepTailForTokens
const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `第${i}条`.repeat(20) }));
const keepSmall = meter.keepTailForTokens(many, 100, 4, 48);
assert.ok(keepSmall >= 4 && keepSmall <= 20, `小预算应收尾（实际 ${keepSmall}）`);
const keepBig = meter.keepTailForTokens(many, 100_000, 4, 48);
assert.ok(keepBig > keepSmall, '预算越大保留越多');
ok('keepTailForTokens：按预算收尾且守下限');

// --------------------------------------------------- A① token 触发压缩
/** 长消息 × 20 条：条数远不到 96，但估算会超阈值 */
const longMsgs = [];
for (let i = 0; i < 20; i++) {
    longMsgs.push({ role: 'user', content: `第${i}轮提问：${'细节'.repeat(400)}` });
    longMsgs.push({ role: 'assistant', content: `<replies><msg>${'回答'.repeat(400)}</msg></replies>` });
}
const tokensLong = meter.estimateMessagesTokens(longMsgs);
assert.ok(tokensLong > 3000, `长消息估算 ${tokensLong} token`);
const smallBudget = {
    window: 10_000,
    thresholdTokens: 3000, // 故意压到估算之下，模拟「窗口小/要求早压」
    retainTokens: 800,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    source: 'test',
};
const s1 = { messages: longMsgs.map((m) => ({ ...m })) };
assert.strictEqual(s1.messages.length, 40, '起始 40 条（远不到 96）');
assert.strictEqual(
    compact.maybeCompactSession(s1, smallBudget),
    true,
    'A①：估算超阈值就必须压（哪怕只有 40 条）',
);
assert.ok(s1.messages.length < 40, '压后条数应下降');
assert.ok(
    s1.messages.length <= Math.max(9, 40),
    '压后应只留 digest + 尾段',
);
assert.ok(
    compact.isDigestMessage(s1.messages[0]),
    'digest 必须落在 index 0',
);
assert.ok(
    !s1.messages.slice(1).some((m) => compact.isDigestMessage(m)),
    '尾部不得残留 digest',
);
ok('A① token 触发：条数未到 96 也按预算压缩');

// 不超阈值时不压
const s2 = { messages: longMsgs.map((m) => ({ ...m })) };
compact.maybeCompactSession(s2, { ...smallBudget, thresholdTokens: tokensLong + 10_000 });
assert.strictEqual(s2.messages.length, 40, '未达阈值不得压缩');
ok('A① 未达阈值不动历史');

// 条数硬阀：不传 budget 时仍是 96 条触发（老行为）
const shortMsgs = Array.from({ length: 95 }, (_, i) => ({ role: 'user', content: `m${i}` }));
const s3 = { messages: shortMsgs.map((m) => ({ ...m })) };
assert.strictEqual(compact.maybeCompactSession(s3), false, '95 条不压');
const s4 = { messages: [...shortMsgs, { role: 'user', content: 'm95' }] };
assert.strictEqual(compact.maybeCompactSession(s4), true, '96 条按硬阀压');
assert.strictEqual(s4.messages.length, 1 + compact.COMPACT_KEEP_TAIL, '压后 1 + 48');
ok('条数硬阀仍生效（不传 budget 时行为与老版一致）');

// --------------------------------------------------- A② 影子日志 + 台账
const s5 = { messages: longMsgs.map((m) => ({ ...m })) };
const firstOriginal = s5.messages[0].content;
compact.maybeCompactSession(s5, smallBudget);
assert.ok(Array.isArray(s5.shadow_log) && s5.shadow_log.length > 0, 'A② 影子日志必须有内容');
assert.ok(
    s5.shadow_log.some((m) => m.content === firstOriginal),
    'A② 最早被遮蔽的原文要能逐字回放',
);
// 被遮蔽的最后一条：用台账的 dropped 数反推（不猜索引，尾段本来就不该进影子日志）
const droppedCount = Number((s5.compactions || [])[0]?.dropped) || 0;
assert.ok(droppedCount > 0, '台账要给出 dropped 条数');
const lastDroppedOriginal = longMsgs[droppedCount - 1].content;
assert.ok(
    s5.shadow_log.some((m) => m.content === lastDroppedOriginal),
    `A② 被遮蔽的最后一条（第 ${droppedCount} 条）也要在影子日志里`,
);
assert.ok(
    !s5.shadow_log.some((m) => m.content === longMsgs[droppedCount].content),
    'A② 保留尾段不该进影子日志（那是仍在 messages 里的 verbatim 历史）',
);
assert.ok(
    s5.shadow_log.length <= compact.SHADOW_LOG_MAX_MESSAGES,
    '影子日志按条数有界',
);
const shadowBytes = s5.shadow_log.reduce((a, m) => a + Buffer.byteLength(m.content, 'utf8'), 0);
assert.ok(shadowBytes <= compact.SHADOW_LOG_MAX_BYTES, `影子日志按字节有界（${shadowBytes}）`);
assert.strictEqual(s5.compaction_epoch, 1, 'epoch 应 +1');
const rec = (s5.compactions || [])[0];
assert.ok(rec, '必须有 compaction 台账');
assert.strictEqual(rec.prefix_invalid_from, 'messages[0]', '必须写明前缀失效点');
assert.ok(rec.dropped > 0 && rec.kept > 0, '台账要记 dropped/kept');
assert.ok(Number(rec.tokens_before) > 3000, `台账要记压前 token（${rec.tokens_before}）`);
assert.strictEqual(rec.retain_tokens, smallBudget.retainTokens);
assert.strictEqual(rec.kind, 'compact');
assert.strictEqual(rec.trigger, 'tokens', 'token 预算触发的压缩要在台账里标 trigger=tokens');
ok('A② 影子日志（原文留档、有界）+ 压缩台账（含失效点）');

// 重复压缩：FIFO 有界 + epoch 累加
for (let i = 0; i < 8; i++) {
    s5.messages.push(
        { role: 'user', content: `追加${i}：${'细节'.repeat(200)}` },
        { role: 'assistant', content: `<replies><msg>${'回答'.repeat(200)}</msg></replies>` },
    );
    compact.maybeCompactSession(s5, smallBudget);
}
assert.ok(s5.compaction_epoch > 1, '每次压缩 epoch 累加');
assert.ok(s5.shadow_log.length <= compact.SHADOW_LOG_MAX_MESSAGES, '影子日志仍守上限');
const shadowBytes2 = s5.shadow_log.reduce((a, m) => a + Buffer.byteLength(m.content, 'utf8'), 0);
assert.ok(shadowBytes2 <= compact.SHADOW_LOG_MAX_BYTES, '影子日志字节仍守上限');
assert.ok((s5.compactions || []).length <= compact.COMPACTION_RECORD_MAX, '台账条数有界');
ok('A② 反复压缩仍有界（FIFO + 台账上限）');

// ------------------------------------------- 前缀失效归因（epoch 机制）
const s6 = { messages: [{ role: 'user', content: 'hi' }], compaction_epoch: 0 };
const hash1 = compose.recordSentApiPrefix(s6, 'SYS', [{ role: 'user', content: 'hi' }]);
assert.strictEqual(s6.last_api_prefix_hash, hash1);
assert.strictEqual(s6.last_api_prefix_epoch, 0, '发请求时记下当时 epoch');
const s7 = { messages: longMsgs.map((m) => ({ ...m })) };
compose.recordSentApiPrefix(s7, 'SYS', [{ role: 'user', content: 'x' }]);
compact.maybeCompactSession(s7, smallBudget);
assert.notStrictEqual(
    s7.compaction_epoch,
    s7.last_api_prefix_epoch,
    '压过之后 epoch 与「上次发请求时」的 epoch 必然不等 → 可判定前缀必失配',
);
const composeSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compose.ts'), 'utf8');
assert.ok(composeSrc.includes('prefixResetReason'), 'compose 必须给出失配归因字段');
assert.ok(
    /compacted/.test(composeSrc) && /last_api_prefix_epoch/.test(composeSrc),
    'compose 必须能区分「刚压过」与「前缀被改脏」',
);
ok('前缀失效可归因：epoch 不等 → prefixResetReason=compacted');

// 配置层：两个比例可配且有默认值
const dcfg = cfgMod.defaultSmartChatConfig();
assert.strictEqual(dcfg.compact_threshold_ratio, 0.8);
assert.strictEqual(dcfg.compact_retain_ratio, 0.16);
const ncfg = cfgMod.normalizeSmartChatConfig({ compact_threshold_ratio: 5, compact_retain_ratio: 9 });
assert.strictEqual(ncfg.compact_threshold_ratio, 0.95);
assert.ok(ncfg.compact_retain_ratio < ncfg.compact_threshold_ratio);
const finger = await loadModule('src/auth/smart-chat-fingerprint.ts');
const fpA = finger.sessionConfigFingerprint({ ...dcfg });
const fpB = finger.sessionConfigFingerprint({ ...dcfg, compact_threshold_ratio: 0.6 });
assert.strictEqual(fpA, fpB, '压缩比例不得进会话指纹（调节奏不该切会话）');
ok('配置层：比例可配 + 不进指纹');

removeTmpDir(tmpDir);
console.log(`\nverify-context-budget: 全部通过（${n} 组断言）`);
