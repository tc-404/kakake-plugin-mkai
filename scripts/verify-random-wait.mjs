/**
 * 1.3.2 随机等待计时验收（真跑函数 + 源码约束双保险）
 *
 * @ts-nocheck 铺满全仓，tsc 兜不住签名错配，所以这里用 esbuild 把源码打成
 * 临时 esm 再 import 进来跑真实分支。
 *
 * 覆盖：
 *   pickRandomWaitMs      整分钟抽样、边界、倒挂输入兜正、非法 rnd 不越界
 *   jitterWaitMs          ±30 秒抖动、上下限不越界、抖完不落整分钟
 *   resolveFlushDelay     开/关两套口径、硬上限收口、旧 batch_max_age_ms 不废掉新功能
 *   shouldFlushByBatchCount   满批必发、<8 不提前、8..cap 递增概率（行为不得回归）
 *   resetFlushTimers      撤计时 + 清表，重载后从零重抽
 *   计时代数作废          新消息重抽后，旧计时到点自己作废
 *   normalizeSmartChatConfig  新字段默认值/clamp/倒挂兜正
 *   源码约束              随机分支到点直发、指纹不含新字段、cleanup 已接线
 *
 * 运行：node scripts/verify-random-wait.mjs
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
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-'));

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

const MIN = 60000;          // 1 分钟
const MAX = 1800000;        // 30 分钟
const OLD_MAX_AGE = 120000; // 现存 batch_max_age_ms = 2 分钟

const flush = await loadModule('src/auth/smart-chat-flush.ts');
const cfgMod = await loadModule('src/auth/smart-chat-config.ts');

/** 固定序列的假随机：可复现，断言不靠运气 */
function seq(values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

// ------------------------------------------------------------ pickRandomWaitMs
assert.strictEqual(flush.pickRandomWaitMs(MIN, MAX, () => 0), MIN, 'rnd=0 → 抽到下限 1 分钟');
assert.strictEqual(
    flush.pickRandomWaitMs(MIN, MAX, () => 0.99999), MAX,
    'rnd→1 → 抽到上限 30 分钟',
);
assert.strictEqual(
    flush.pickRandomWaitMs(MIN, MAX, () => 1), MAX,
    'rnd=1（越界）也收在上限，不溢出成 31 分钟',
);
assert.strictEqual(flush.pickRandomWaitMs(MIN, MAX, () => -5), MIN, 'rnd 负数 → 收到下限');
assert.strictEqual(flush.pickRandomWaitMs(MIN, MAX, () => Number.NaN), MIN, 'rnd=NaN → 收到下限');

// 抽到 4 分钟 / 2 分钟：用户举的例子，落到整分钟
assert.strictEqual(
    flush.pickRandomWaitMs(MIN, MAX, () => 3 / 30), 4 * 60000,
    '抽样应落在整分钟上（例：4 分钟）',
);
assert.strictEqual(
    flush.pickRandomWaitMs(MIN, MAX, () => 1 / 30), 2 * 60000,
    '抽样应落在整分钟上（例：2 分钟）',
);

// 1-30 全覆盖，且不越界、不出现非整分钟
const seen = new Set();
for (let i = 0; i < 30; i += 1) {
    const ms = flush.pickRandomWaitMs(MIN, MAX, () => i / 30);
    assert.ok(ms >= MIN && ms <= MAX, `抽样必须落在 [1,30] 分钟内，实测 ${ms}`);
    assert.strictEqual(ms % 60000, 0, `抽样必须是整分钟，实测 ${ms}`);
    seen.add(ms / 60000);
}
assert.strictEqual(seen.size, 30, `1-30 分钟应全覆盖，实测 ${seen.size} 种`);

// 真随机跑一遍也不许越界
for (let i = 0; i < 2000; i += 1) {
    const ms = flush.pickRandomWaitMs(MIN, MAX);
    assert.ok(ms >= MIN && ms <= MAX && ms % 60000 === 0, `真随机越界：${ms}`);
}

// 倒挂输入自动兜正
assert.strictEqual(
    flush.pickRandomWaitMs(MAX, MIN, () => 0), MAX,
    'min/max 写反 → 以较大者为上限，不返回 0 也不死循环',
);

// ----------------------------------------------------------------- jitterWaitMs
// 抖动的目的：抽样落在整分钟上，盯时间戳的人会发现「回复时刻 - 末条消息时刻」永远是
// 整数分钟；摊 ±30 秒后这条规律就不成立了，日志里仍能看到原始抽样值。
assert.strictEqual(flush.jitterWaitMs(4 * 60000, MIN, MAX, () => 0.5), 4 * 60000, 'r=0.5 → 不偏移');
assert.strictEqual(flush.jitterWaitMs(4 * 60000, MIN, MAX, () => 0), 4 * 60000 - 30000, 'r=0 → -30 秒');
assert.strictEqual(
    flush.jitterWaitMs(4 * 60000, MIN, MAX, () => 0.99999), 4 * 60000 + 29999,
    'r→1 → +30 秒以内',
);
assert.strictEqual(flush.jitterWaitMs(MIN, MIN, MAX, () => 0), MIN, '抖动不许低于下限（抽到 1 分钟别变 30 秒）');
assert.strictEqual(flush.jitterWaitMs(MAX, MIN, MAX, () => 0.99999), MAX, '抖动不许高于上限');
assert.strictEqual(flush.jitterWaitMs(Number.NaN, MIN, MAX, () => 0.5), MIN, '非法输入收到下限');
let nonWhole = 0;
for (let i = 0; i < 600; i += 1) {
    const ms = flush.jitterWaitMs(10 * 60000, MIN, MAX);
    assert.ok(ms >= MIN && ms <= MAX, `抖动后越界：${ms}`);
    if (ms % 60000 !== 0) nonWhole += 1;
}
assert.ok(nonWhole > 560, `抖动后绝大多数不该落在整分钟上，实测 ${nonWhole}/600`);

// ----------------------------------------------------------- resolveFlushDelay
const baseCfg = {
    debounce_ms: 8000,
    max_batch: 12,
    batch_max_age_ms: OLD_MAX_AGE,
    random_wait_enabled: true,
    random_wait_min_ms: MIN,
    random_wait_max_ms: MAX,
};

const off = flush.resolveFlushDelay({ ...baseCfg, random_wait_enabled: false }, 0, () => 0.5);
assert.strictEqual(off.mode, 'debounce', '关闭随机等待 → 退回 debounce 口径');
assert.strictEqual(off.waitMs, 8000, '关闭时等待值就是 debounce_ms');

// rnd 用固定序列：第 1 次给抽样、第 2 次给抖动（0.5 = 不偏移），断言才能盯住整分钟值
const fresh = flush.resolveFlushDelay(baseCfg, 0, seq([3 / 30, 0.5]));
assert.strictEqual(fresh.mode, 'random', '开启 → random 口径');
assert.strictEqual(fresh.waitMs, 4 * 60000, '缓冲还新 → 抽到多少等多少（抖动 0 偏移）');
assert.strictEqual(fresh.capped, false, '未触上限不应标 capped');

// 抖动确实作用在最终等待值上（同一个抽样值，不同抖动 → 不同落点）
const jitLow = flush.resolveFlushDelay(baseCfg, 0, seq([3 / 30, 0]));
assert.strictEqual(jitLow.drawMs, 4 * 60000, '日志用的抽样值仍是整分钟');
assert.strictEqual(jitLow.waitMs, 4 * 60000 - 30000, '实际等待被抖到 3 分 30 秒');

// 关键回归：现存 batch_max_age_ms=2 分钟不得把 1-30 分钟随机等待压回 2 分钟
const notSquashed = flush.resolveFlushDelay(baseCfg, 90000, () => 0.99999);
assert.ok(
    notSquashed.waitMs > OLD_MAX_AGE,
    `硬上限应取 max(batch_max_age_ms, random_wait_max_ms)=30 分钟；`
    + `若被 2 分钟压回则新功能等于没开（实测 ${notSquashed.waitMs}）`,
);
assert.strictEqual(
    notSquashed.waitMs, MAX - 90000,
    '抽到 30 分钟且最老一条已等 1.5 分钟 → 收口到「还差多久满 30 分钟」',
);

// 最老一条快到硬上限：收口到剩余时间，不再无限重抽饿着
const nearCap = flush.resolveFlushDelay(baseCfg, MAX - 90000, () => 0.99999);
assert.strictEqual(nearCap.capped, true, '快到硬上限应标 capped');
assert.strictEqual(nearCap.waitMs, 90000, '收口到「还差多久到硬上限」');
assert.strictEqual(nearCap.drawMs, MAX, 'drawMs 应保留原始抽样值供日志对照');

const overCap = flush.resolveFlushDelay(baseCfg, MAX + 60000, () => 0.5);
assert.strictEqual(overCap.waitMs, 0, '已超硬上限 → 立即访问');
assert.strictEqual(overCap.capped, true);

const nanAge = flush.resolveFlushDelay(baseCfg, Number.NaN, seq([3 / 30, 0.5]));
assert.strictEqual(nanAge.waitMs, 4 * 60000, '年龄不可解析 → 不收口，按抽样值等');
assert.strictEqual(nanAge.capped, false);

// batch_max_age_ms 被调到比随机上限还大时，硬上限跟着它走
const bigAge = flush.resolveFlushDelay(
    { ...baseCfg, batch_max_age_ms: 45 * 60000 }, 44 * 60000, () => 0.99999,
);
assert.strictEqual(bigAge.waitMs, 60000, '硬上限=45 分钟时按它收口');

// 缺字段的旧配置：不炸，按默认 1-30 分钟走
const legacy = flush.resolveFlushDelay({ debounce_ms: 8000, max_batch: 12 }, 0, () => 0);
assert.strictEqual(legacy.mode, 'random', '旧配置缺 random_wait_enabled → 默认开启');
assert.strictEqual(legacy.waitMs, MIN, '缺 min/max → 回落 1 分钟下限');

// ------------------------------------------------ shouldFlushByBatchCount 不回归
assert.strictEqual(flush.PROB_FLUSH_MIN_BATCH, 8, '概率提前访问的起算条数应为 8');
assert.strictEqual(flush.shouldFlushByBatchCount(12, 12), true, '满批必发');
assert.strictEqual(flush.shouldFlushByBatchCount(13, 12), true, '超批必发');
assert.strictEqual(flush.shouldFlushByBatchCount(0, 12), false, '空缓冲不发');
for (let n = 1; n < 8; n += 1) {
    for (let i = 0; i < 50; i += 1) {
        assert.strictEqual(
            flush.shouldFlushByBatchCount(n, 12), false,
            `未满 8 条不许概率提前（n=${n}）`,
        );
    }
}
for (let i = 0; i < 50; i += 1) {
    assert.strictEqual(
        flush.shouldFlushByBatchCount(7, 8), false,
        'max_batch ≤ 8 时未满上限不提前',
    );
}

// 概率曲线：p(n) = (n-8+1)/(cap-8+1)，cap=12 → 0.2 / 0.4 / 0.6 / 0.8
const realRandom = Math.random;
try {
    for (const [n, p] of [[8, 0.2], [9, 0.4], [10, 0.6], [11, 0.8]]) {
        Math.random = () => p - 1e-9;
        assert.strictEqual(
            flush.shouldFlushByBatchCount(n, 12), true,
            `n=${n} 时随机值刚好低于 ${p} 应提前`,
        );
        Math.random = () => p + 1e-9;
        assert.strictEqual(
            flush.shouldFlushByBatchCount(n, 12), false,
            `n=${n} 时随机值刚好高于 ${p} 不应提前`,
        );
    }
} finally {
    Math.random = realRandom;
}

// -------------------------------------------------------- resetFlushTimers 真跑
let fired = 0;
flush.chatTimers.clear();
for (const id of ['g_1', 'g_2', 'g_3']) {
    flush.chatTimers.set(id, {
        timer: setTimeout(() => { fired += 1; }, 30),
        waitMs: 60000,
        armedAt: Date.now(),
        seq: 1,
    });
}
assert.strictEqual(flush.chatTimers.size, 3, '预置 3 个计时');
assert.strictEqual(flush.resetFlushTimers(), 3, 'resetFlushTimers 应报告撤掉 3 个');
assert.strictEqual(flush.chatTimers.size, 0, '重载后计时表必须清空');
await new Promise((r) => setTimeout(r, 80));
assert.strictEqual(fired, 0, '被撤掉的计时不许再触发');
assert.strictEqual(flush.resetFlushTimers(), 0, '空表重复调用应安全返回 0');

// ------------------------------------------- 计时代数：新消息重抽后旧计时自作废
// 模拟 scheduleFlush 的作废条件：chatTimers.get(id) !== state || state.seq !== mySeq
const stale = { timer: null, seq: 1 };
flush.chatTimers.set('g_seq', stale);
const mySeq = stale.seq;
stale.seq = 2; // 新消息到达 → 重抽 → 代数 +1
assert.ok(
    flush.chatTimers.get('g_seq') === stale && stale.seq !== mySeq,
    '重抽后旧回调的代数应已过期（旧计时废弃，缓存不受影响）',
);
flush.chatTimers.clear();

// ------------------------------------------------------ invalidateFlushTimer 真跑
let firedB = 0;
const st = {
    timer: setTimeout(() => { firedB += 1; }, 30),
    waitMs: 4 * 60000,
    armedAt: Date.now(),
    seq: 7,
};
flush.chatTimers.set('g_at', st);
flush.invalidateFlushTimer('g_at');
assert.strictEqual(st.timer, null, '满批/艾特立即访问时应撤掉挂着的计时');
assert.strictEqual(st.seq, 8, '并递增代数，让已入队的旧回调自己作废');
await new Promise((r) => setTimeout(r, 80));
assert.strictEqual(firedB, 0, '被作废的计时不许再触发');
assert.doesNotThrow(() => flush.invalidateFlushTimer('g_not_exist'), '未知 chatId 不该抛');
flush.chatTimers.clear();

// ---------------------------------------------------- 配置默认值 / clamp / 兜正
const dflt = cfgMod.defaultSmartChatConfig();
assert.strictEqual(dflt.random_wait_enabled, true, '默认开启随机等待');
assert.strictEqual(dflt.random_wait_min_ms, MIN, '默认下限 1 分钟');
assert.strictEqual(dflt.random_wait_max_ms, MAX, '默认上限 30 分钟');

const n1 = cfgMod.normalizeSmartChatConfig({});
assert.strictEqual(n1.random_wait_enabled, true, '空配置 → 默认开启');
assert.strictEqual(n1.random_wait_min_ms, MIN);
assert.strictEqual(n1.random_wait_max_ms, MAX);

const n2 = cfgMod.normalizeSmartChatConfig({ random_wait_enabled: false });
assert.strictEqual(n2.random_wait_enabled, false, '显式 false 应生效');
assert.strictEqual(
    cfgMod.normalizeSmartChatConfig({ random_wait_enabled: 'false' }).random_wait_enabled, false,
    "字符串 'false' 也应关闭",
);

const n3 = cfgMod.normalizeSmartChatConfig({ random_wait_min_ms: 600000, random_wait_max_ms: 120000 });
assert.strictEqual(n3.random_wait_min_ms, 120000, '倒挂输入应兜正为 min=较小者');
assert.strictEqual(n3.random_wait_max_ms, 600000, '倒挂输入应兜正为 max=较大者');

const n4 = cfgMod.normalizeSmartChatConfig({ random_wait_min_ms: 0, random_wait_max_ms: 99999999 });
assert.strictEqual(n4.random_wait_min_ms, 1000, '下限 clamp 到 1000ms');
assert.strictEqual(n4.random_wait_max_ms, 3600000, '上限 clamp 到 60 分钟');

// 改随机等待不该切会话/丢记忆 → 指纹必须一致
const fpMod = await loadModule('src/auth/smart-chat-fingerprint.ts');
const fpBase = fpMod.sessionConfigFingerprint(cfgMod.normalizeSmartChatConfig({
    api_key: 'k', base_url: 'https://x', model: 'auto', system_prompt: '汐音',
}));
const fpTweaked = fpMod.sessionConfigFingerprint(cfgMod.normalizeSmartChatConfig({
    api_key: 'k', base_url: 'https://x', model: 'auto', system_prompt: '汐音',
    random_wait_enabled: false, random_wait_min_ms: 120000, random_wait_max_ms: 600000,
}));
assert.strictEqual(
    fpTweaked, fpBase,
    '改随机等待三项后指纹必须不变，否则一调等待节奏就换会话、丢历史与记忆',
);

// ------------------------------------------------------------------ 源码约束
const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
assert.ok(
    /state\.seq = \(Number\(state\.seq\) \|\| 0\) \+ 1;/.test(flushSrc),
    'scheduleFlush 每次必须递增计时代数，否则旧计时可能抢跑',
);
assert.ok(
    /state\.seq !== mySeq\) return;/.test(flushSrc),
    '计时回调必须校验代数，clearTimeout 拦不住已入队的回调',
);
assert.ok(
    /随机等待到点，访问/.test(flushSrc),
    '随机等待到点应直接访问（不再要求满批或超龄）',
);
assert.ok(
    /const jittered = jitterWaitMs\(drawMs, minMs, maxMs, rnd\);/.test(flushSrc),
    'resolveFlushDelay 必须对抽样值摊秒级抖动（整分钟等待本身就是可观测规律）',
);
assert.ok(
    /已摊秒级抖动/.test(flushSrc),
    '日志要能区分「抽到多少分钟」与「实际等多久」，否则线上无从核对',
);
assert.ok(
    /if \(wait > 0\) arm\(/.test(flushSrc),
    '关闭随机等待时仍须保留 1.3.1 的续倒计时逻辑',
);

const fpSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-fingerprint.ts'), 'utf8');
assert.ok(
    !/random_wait/.test(fpSrc),
    '随机等待字段不得进会话指纹（改等待节奏不该切会话/丢记忆）',
);

const coreSrc = fs.readFileSync(path.join(root, 'src/mkai-core.ts'), 'utf8');
assert.ok(
    /shutdownSmartChatRuntime\(\)/.test(coreSrc),
    'plugin_cleanup 必须撤掉随机计时',
);
const chatSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat.ts'), 'utf8');
assert.ok(
    /resetFlushTimers\(\)/.test(chatSrc),
    'initSmartChatRuntime 必须清残留计时（重载后从零重抽）',
);
assert.strictEqual(
    (chatSrc.match(/invalidateFlushTimer\(chatId\);/g) || []).length, 2,
    '艾特 与 识图补充 两个立即访问入口都要作废旧计时（各 1 处，共 2 处）',
);
assert.ok(
    !/clearTimeout/.test(chatSrc),
    '撤计时应统一走 invalidateFlushTimer，别再散着手写 clearTimeout（漏递增代数会让旧计时抢跑）',
);

// ---- 反应延迟：满批/概率触发不再 0 秒发请求 ----
const { pickReactionDelayMs, REACTION_DELAY_MIN_MS, REACTION_DELAY_MAX_MS } = flush;
assert.strictEqual(REACTION_DELAY_MIN_MS, 5000, '反应延迟下限 5 秒');
assert.strictEqual(REACTION_DELAY_MAX_MS, 45000, '反应延迟上限 45 秒');
assert.strictEqual(pickReactionDelayMs(() => 0), REACTION_DELAY_MIN_MS, 'rnd=0 → 下限');
assert.strictEqual(pickReactionDelayMs(() => 1), REACTION_DELAY_MAX_MS, 'rnd=1 收口到上限');
assert.strictEqual(pickReactionDelayMs(() => -1), REACTION_DELAY_MIN_MS, '负数回落下限');
assert.strictEqual(pickReactionDelayMs(() => NaN), REACTION_DELAY_MIN_MS, 'NaN 回落下限');
for (let i = 0; i < 5000; i += 1) {
    const d = pickReactionDelayMs();
    assert.ok(
        d >= REACTION_DELAY_MIN_MS && d <= REACTION_DELAY_MAX_MS,
        `反应延迟越界：${d}`,
    );
}
assert.ok(
    new Set(Array.from({ length: 200 }, () => pickReactionDelayMs())).size > 20,
    '反应延迟必须真随机（取值集中就等于换了个固定节奏）',
);

assert.ok(
    /if \(shouldFlushByBatchCount\(pending\.length, config\.max_batch\)\) \{[\s\S]{0,400}?scheduleReactionFlush\(deps, chatId\);/.test(chatSrc),
    '满批/概率触发必须走 scheduleReactionFlush，不能再 0 秒 await flushChat',
);
assert.ok(
    /if \(forceByAt\) \{[\s\S]{0,400}?await flushChat\(deps, chatId, \{ force: true \}\);/.test(chatSrc),
    '被艾特仍须立即访问（叫到名字还慢半分钟更怪），并带 force 穿透失败退避',
);
assert.ok(
    /if \(state\.timer && Number\(state\.reactAt\) > now\) return;/.test(flushSrc),
    '反应延迟必须幂等：已装载未到点时不重抽，否则活跃群里会被新消息无限后推',
);
assert.ok(
    /reactAt = 0;/.test(flushSrc),
    'invalidateFlushTimer / scheduleFlush / 到点回调都要清 reactAt，避免旧目标时刻挡住新计时',
);
assert.ok(
    /满批\/概率触发，反应延迟/.test(flushSrc),
    '反应延迟要留日志，线上才能核对实际间隔',
);
assert.ok(
    /} else if \(shouldFlushByBatchCount\(leftover\.length, cfg\.max_batch\)\) \{/.test(flushSrc),
    'leftover 的满批分支也要走反应延迟（上一轮刚说完紧接着再发也是可观测特征）',
);

const webSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-web.ts'), 'utf8');
for (const field of ['random_wait_enabled', 'random_wait_min_ms', 'random_wait_max_ms']) {
    assert.ok(
        new RegExp(`body\\.${field} != null`).test(webSrc),
        `后台 PATCH 应接收 ${field}`,
    );
}

removeTmpDir(tmpDir);

if (process.argv.includes('--table')) {
    console.log('抽样分布（真随机 30000 次，分钟 → 次数）：');
    const hist = new Map();
    for (let i = 0; i < 30000; i += 1) {
        const m = flush.pickRandomWaitMs(MIN, MAX) / 60000;
        hist.set(m, (hist.get(m) || 0) + 1);
    }
    for (const m of [...hist.keys()].sort((a, b) => a - b)) {
        console.log(`  ${String(m).padStart(2)} 分钟  ${hist.get(m)}`);
    }
}
console.log('verify-random-wait: 全部通过');