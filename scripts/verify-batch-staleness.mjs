/**
 * 1.1 batch 陈旧上限 + 1.5 对话关系图验收（真跑函数，不是文本断言）
 *
 * @ts-nocheck 铺满全仓，tsc 兜不住签名错配，所以这里用 esbuild 把源码打成
 * 临时 esm 再 import 进来跑真实分支。
 *
 * 覆盖：
 *   shouldFlushOnDebounce 超龄逃生口（含老口径不回归）
 *   oldestPendingAgeMs / sortBatchByTime
 *   splitVisitByStaleness / resolveBatchVisit 分层优先级
 *   formatVisitBody 的 main-visit / side-context 输出
 *   buildTalkGraph 的关系边、独立话头、结论行、字符预算、重名消歧
 *
 * 运行：npm run verify:staleness
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
// 落在项目 node_modules 内：external 依赖（extract-zip）才解析得到
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

/** 'YYYY-MM-DD HH:mm:ss' 本地时间串 */
function ts(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function entry(minutesAgo, over = {}) {
    const base = Date.now() - minutesAgo * 60000;
    return {
        userId: over.userId || '1001',
        nickname: over.nickname || '甘甜',
        text: over.text || `第 ${minutesAgo} 分钟前的发言`,
        time: ts(base),
        messageId: over.messageId || `m${minutesAgo}`,
        atQqs: over.atQqs || [],
        eventSnapshot: { self_id: '2071521294', message_type: 'group', group_id: '955682835' },
        ...over,
    };
}

const compose = await loadModule('src/auth/smart-chat-compose.ts');
const flush = await loadModule('src/auth/smart-chat-flush.ts');

// ---------------------------------------------------------------- flush 闸门
const MAX_BATCH = 12;
const MAX_AGE = 120000;

assert.strictEqual(
    flush.shouldFlushOnDebounce(3, MAX_BATCH), false,
    '老口径：未满批且没给年龄 → 不 flush',
);
assert.strictEqual(flush.shouldFlushOnDebounce(MAX_BATCH, MAX_BATCH), true, '满批 → flush');
assert.strictEqual(flush.shouldFlushOnDebounce(0, MAX_BATCH, 999999, MAX_AGE), false, '空缓冲不 flush');
assert.strictEqual(
    flush.shouldFlushOnDebounce(3, MAX_BATCH, MAX_AGE + 10000, MAX_AGE), true,
    '未满批但超龄 → 强制 flush',
);
assert.strictEqual(
    flush.shouldFlushOnDebounce(3, MAX_BATCH, MAX_AGE - 10000, MAX_AGE), false,
    '未满批未超龄 → 继续等',
);
assert.strictEqual(
    flush.shouldFlushOnDebounce(3, MAX_BATCH, Number.NaN, MAX_AGE), false,
    '年龄不可解析 → 退回老口径，不误判超龄',
);
assert.strictEqual(
    flush.shouldFlushOnDebounce(3, MAX_BATCH, 999999, 0), false,
    'maxAge=0（关掉超龄）→ 只看满批',
);

const age = flush.oldestPendingAgeMs([entry(5), entry(1), entry(9)]);
assert.ok(age >= 8.5 * 60000 && age <= 9.5 * 60000, `最老一条年龄应约 9 分钟，实测 ${Math.round(age / 60000)}`);
assert.ok(
    Number.isNaN(flush.oldestPendingAgeMs([{ time: 'x' }, { time: '' }])),
    '全无可解析时间戳 → NaN',
);
assert.ok(Number.isNaN(flush.oldestPendingAgeMs([])), '空数组 → NaN');

// ---------------------------------------------------------------- 时间戳排序
const messy = [entry(1, { messageId: 'a' }), entry(9, { messageId: 'b' }), entry(5, { messageId: 'c' })];
assert.deepStrictEqual(
    compose.sortBatchByTime(messy).map((b) => b.messageId), ['b', 'c', 'a'],
    '按时间升序',
);
const withBad = [
    entry(1, { messageId: 'a' }),
    { messageId: 'bad1', time: 'oops' },
    entry(9, { messageId: 'b' }),
    { messageId: 'bad2', time: '' },
];
const sortedIds = compose.sortBatchByTime(withBad).map((b) => b.messageId);
assert.strictEqual(sortedIds.length, 4, '排序不丢条目');
assert.ok(
    sortedIds.indexOf('bad1') < sortedIds.indexOf('bad2'),
    '无法解析时间的条目保持原相对位置（稳定排序）',
);

// ---------------------------------------------------------------- 陈旧拆批
const SELF = '2071521294';
const staleBatch = compose.sortBatchByTime([
    entry(147, { messageId: 'old1' }),
    entry(140, { messageId: 'old2' }),
    entry(132, { messageId: 'old3' }),
    entry(120, { messageId: 'old4' }),
    entry(1, { messageId: 'new1' }),
    entry(0, { messageId: 'new2' }),
]);

const split = compose.splitVisitByStaleness(staleBatch, MAX_AGE);
assert.strictEqual(split.staleSplit, true, '跨 147 分钟应拆批');
assert.deepStrictEqual(split.fresh.map((b) => b.messageId), ['new1', 'new2'], '近窗口进 fresh');
assert.strictEqual(split.stale.length, 4, '其余 4 条降级为陈旧');
assert.ok(split.staleMinutes >= 140, `陈旧分钟数应约 147，实测 ${split.staleMinutes}`);

assert.strictEqual(
    compose.splitVisitByStaleness(staleBatch.slice(-4), MAX_AGE).staleSplit, false,
    `不足 ${compose.STALE_SPLIT_MIN_ENTRIES} 条的小批不拆`,
);
// 参照点是「本批最新一条」而非 now：整批都很老但彼此贴得很近 → 不拆
assert.strictEqual(
    compose.splitVisitByStaleness(
        [entry(200), entry(200.2), entry(200.4), entry(200.6), entry(200.8)], MAX_AGE,
    ).staleSplit,
    false,
    '整批时间贴近（哪怕绝对时间都很老）→ 不拆',
);
// 反过来：整批都很老但内部跨度大 → 仍按批内相对时间拆（保证同批重算结果一致）
assert.strictEqual(
    compose.splitVisitByStaleness(
        [entry(200), entry(190), entry(180), entry(170), entry(160)], MAX_AGE,
    ).staleSplit,
    true,
    '批内跨度超 cutoff → 以批内最新一条为参照拆批',
);
assert.strictEqual(
    compose.splitVisitByStaleness(staleBatch, 0).staleSplit, false,
    'cutoff=0（关掉）→ 不拆',
);

// ---------------------------------------------------------------- 分层优先级
const layout = compose.resolveBatchVisit(staleBatch, SELF, MAX_AGE);
assert.strictEqual(layout.staleSplit, true, '无艾特时走陈旧拆批');
assert.strictEqual(layout.atTriggered, false);
assert.deepStrictEqual(layout.primary.map((b) => b.messageId), ['new1', 'new2']);

const atBatch = [...staleBatch, entry(0, { messageId: 'at1', atQqs: [SELF], text: `@我 在吗` })];
const atLayout = compose.resolveBatchVisit(atBatch, SELF, MAX_AGE);
assert.strictEqual(atLayout.atTriggered, true, '艾特优先于陈旧');
assert.strictEqual(atLayout.staleSplit, false, '艾特与陈旧不叠加');
assert.strictEqual(atLayout.staleMinutes, 0);

const flatLayout = compose.resolveBatchVisit([entry(1), entry(0)], SELF, MAX_AGE);
assert.strictEqual(flatLayout.atTriggered, false, '小批无艾特 → 整批同等');
assert.strictEqual(flatLayout.staleSplit, false);
assert.strictEqual(flatLayout.primary.length, 0, '整批同等时 primary 为空');

// ---------------------------------------------------------------- 正文分段
const staleBody = compose.formatVisitBody(layout, staleBatch).body;
assert.ok(/<main-visit>/.test(staleBody), '拆批后应有 main-visit');
assert.ok(/<side-context>/.test(staleBody), '拆批后应有 side-context');
assert.ok(/陈旧背景/.test(staleBody), 'side-context 应标注陈旧');
assert.ok(/已过去约 \d+ 分钟/.test(staleBody), 'side-context 应写明过去多久');
assert.ok(/别硬串成一个话题/.test(staleBody), 'side-context 应禁止硬串话题');
assert.ok(!/<batch-messages>/.test(staleBody), '拆批后不再用 batch-messages');

const flatBody = compose.formatVisitBody(flatLayout, [entry(1), entry(0)]).body;
assert.ok(/<batch-messages>/.test(flatBody), '整批同等仍用 batch-messages');
assert.ok(!/<main-visit>/.test(flatBody), '整批同等不应有 main-visit');

const atBody = compose.formatVisitBody(atLayout, atBatch).body;
assert.ok(/艾特你的消息/.test(atBody), '艾特分层的 main-visit 说明保持原文案');
assert.ok(!/陈旧背景/.test(atBody), '艾特分层不应混进陈旧文案');

// ---------------------------------------------------------------- 关系图 1.5
const G_SELF = SELF;
const graphBatch = [
    { userId: '1', nickname: '潇', text: '渔力全开有人玩吗', time: ts(Date.now() - 5 * 60000), messageId: '101', atQqs: [], eventSnapshot: {} },
    { userId: '2', nickname: '寒愁洛', text: '你买了吗', time: ts(Date.now() - 4 * 60000), messageId: '102', atQqs: [], replyToUserId: '1', replyToNickname: '潇', eventSnapshot: {} },
    { userId: '1', nickname: '潇', text: '买了啊', time: ts(Date.now() - 3 * 60000), messageId: '103', atQqs: ['2'], eventSnapshot: {} },
    { userId: '3', nickname: '甘甜', text: '今天好热', time: ts(Date.now() - 2 * 60000), messageId: '104', atQqs: [], eventSnapshot: {} },
];

const g1 = compose.buildTalkGraph(graphBatch, G_SELF, '汐音');
assert.ok(g1.text.startsWith('<talk-graph>'), 'talk-graph 应带标签');
assert.ok(g1.text.endsWith('</talk-graph>'), 'talk-graph 应闭合');
assert.ok(
    g1.text.length <= compose.TALK_GRAPH_MAX_CHARS,
    `talk-graph 不得超 ${compose.TALK_GRAPH_MAX_CHARS} 字符，实测 ${g1.text.length}`,
);
assert.ok(/结论 指向本账号: 无/.test(g1.text), '无人点名时必须给出显式结论');
assert.deepStrictEqual(g1.toBot, [], '没人对 bot 说话');
assert.strictEqual(g1.threads, 1, '潇↔寒愁洛是同一条线');
assert.ok(/寒愁洛→潇/.test(g1.text), '引用关系应算成 寒愁洛→潇');
assert.ok(/潇→寒愁洛/.test(g1.text), '艾特关系应算成 潇→寒愁洛');
assert.ok(/独立话头 甘甜/.test(g1.text), '无回复对象的发言应标独立话头');
assert.ok(!/甘甜→/.test(g1.text), '甘甜没有回复对象，不该有出边');

const g2 = compose.buildTalkGraph(
    [...graphBatch, { userId: '3', nickname: '甘甜', text: '汐音你在吗', time: ts(Date.now()), messageId: '105', atQqs: [G_SELF], eventSnapshot: {} }],
    G_SELF,
    '汐音',
);
assert.deepStrictEqual(g2.toBot, ['3'], '艾特 bot 的人应进 toBot');
assert.ok(/结论 指向本账号: 甘甜（msgid 105）/.test(g2.text), '有人点名时结论应含人与 msgid');
assert.ok(/甘甜→你/.test(g2.text), 'bot 在关系图里显示为「你」');

// 同名不同号：补尾号区分，别并成一个人
const g3 = compose.buildTalkGraph(
    [
        { userId: '5551', nickname: '小明', text: 'a', time: ts(Date.now() - 60000), messageId: '201', atQqs: [], eventSnapshot: {} },
        { userId: '9992', nickname: '小明', text: 'b', time: ts(Date.now()), messageId: '202', atQqs: ['5551'], eventSnapshot: {} },
    ],
    G_SELF,
    '汐音',
);
assert.ok(/…9992|…5551/.test(g3.text), '同名不同号应补尾号');

// 裁剪后撞名：不同全名但前 8 字相同，也必须补尾号区分
const g3b = compose.buildTalkGraph(
    [
        { userId: '7771', nickname: '很长的群友昵称测试甲', text: 'a', time: ts(Date.now() - 60000), messageId: '211', atQqs: [], eventSnapshot: {} },
        { userId: '8882', nickname: '很长的群友昵称测试乙', text: 'b', time: ts(Date.now()), messageId: '212', atQqs: ['7771'], eventSnapshot: {} },
    ],
    G_SELF,
    '汐音',
);
assert.ok(/…7771/.test(g3b.text) && /…8882/.test(g3b.text), '裁剪后撞名也要补尾号，别把两个人并成一个');

// 识图补充 / 眼睛备注不算发言
const g4 = compose.buildTalkGraph(
    [
        { userId: '1', nickname: '潇', text: '补充：图片第1张解析结果…', time: ts(Date.now() - 60000), messageId: '301', atQqs: [], eventSnapshot: {} },
        { userId: '1', nickname: '潇', text: '[眼睛 msgid:301] 看图', time: ts(Date.now()), messageId: '302', atQqs: [], eventSnapshot: {} },
    ],
    G_SELF,
    '汐音',
);
assert.strictEqual(g4.text, '', '全是识图噪声 → 不出关系图');

assert.strictEqual(
    compose.buildTalkGraph([graphBatch[0]], G_SELF, '汐音').text, '',
    '单条且没人点你 → 不出关系图，别白占面板',
);

// 长批也不许超预算
const bigBatch = Array.from({ length: 20 }, (_, i) => ({
    userId: String(100 + i),
    nickname: `很长的群友昵称测试${i}`,
    text: 'x',
    time: ts(Date.now() - (20 - i) * 60000),
    messageId: String(400 + i),
    atQqs: [String(100 + ((i + 1) % 20))],
    eventSnapshot: {},
}));
const g5 = compose.buildTalkGraph(bigBatch, G_SELF, '汐音');
assert.ok(
    g5.text.length <= compose.TALK_GRAPH_MAX_CHARS,
    `20 条互艾特也不能超预算，实测 ${g5.text.length}`,
);
assert.ok(/结论 /.test(g5.text), '裁剪时必须保住结论行');
assert.ok(/条关系省略/.test(g5.text), '裁剪时应说明省略了多少');

// 面板噪音要能被剥掉，否则会固化进 compaction digest
assert.strictEqual(
    compose.stripHistoryUserMeta(`${g2.text}\n\n<batch-messages>\n正文\n</batch-messages>`),
    '<batch-messages>\n正文\n</batch-messages>',
    'stripHistoryUserMeta 应剥掉 talk-graph',
);

// ---------------------------------------------------------------- 源码约束
const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
assert.ok(
    /sortBatchByTime\(takeChatBuffer\(/.test(flushSrc),
    'flushChat 取批后必须按时间升序排一次',
);
assert.ok(
    /if \(wait > 0\) arm\(/.test(flushSrc),
    'scheduleFlush 未满批时必须续倒计时，否则缓冲会一直挂着',
);

removeTmpDir(tmpDir);
if (process.argv.includes('--dump')) {
    console.log('--- 陈旧拆批正文 ---');
    console.log(staleBody);
    console.log('--- 关系图（无人点名）---');
    console.log(g1.text);
    console.log('--- 关系图（有人点名）---');
    console.log(g2.text);
}
console.log('verify-batch-staleness: 全部通过');