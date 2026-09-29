/**
 * 1.3 面板分层瘦身验收（真跑 composeTurn，不是文本断言）
 *
 * 覆盖：
 *   skill-tree 只在稳定 system 出现一次，不再每轮进 user turn
 *   chat-facts（群号/群名/资历/群身份/入群）上移稳定 system，host-state 不再复述
 *   host-state 只留会变的运行事实，且去掉解释性括号
 *   会话内冻结：KB 不变 → system 字节不变；KB 变 → 只重新冻结一次
 *   人设融合预热与正式访问用同一份 system（预热不白跑）
 *   digest 折叠输入侧剥掉面板噪音
 *
 * 运行：npm run verify:panel
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

const cleanup = () => removeTmpDir(tmpDir);
const fail = (e) => {
    cleanup();
    throw e;
};

let compose;
let compact;
let types;
try {
    compose = await loadModule('src/auth/smart-chat-compose.ts');
    compact = await loadModule('src/auth/smart-chat-compact.ts');
    types = await loadModule('src/auth/smart-chat-types.ts');
} catch (e) {
    fail(e);
}

/** 'YYYY-MM-DD HH:mm:ss' 本地时间串 */
function ts(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function entry(minutesAgo, over = {}) {
    return {
        userId: over.userId || '1001',
        nickname: over.nickname || '甘甜',
        text: over.text || `第 ${minutesAgo} 分钟前的发言`,
        time: ts(Date.now() - minutesAgo * 60000),
        messageId: over.messageId || `m${minutesAgo}`,
        atQqs: over.atQqs || [],
        eventSnapshot: { self_id: '2071521294', message_type: 'group', group_id: '955682835' },
        ...over,
    };
}

const CONFIG = {
    system_prompt: '你是群里的「汐音」：测试用定义句。',
    action_min: 0,
    action_max: 3,
    shut_up_limit: 5,
    kb_top_m: 6,
    batch_max_age_ms: 120000,
};

function newSession(over = {}) {
    return {
        messages: [],
        shut_up_streak: 1,
        chat_type: 'group',
        group_id: '955682835',
        group_name: 'MK - Galgame交流群',
        bot_standing: '新成员',
        bot_role_label: '普通成员',
        bot_join_at: '2026-01-06 12:21:05',
        ...over,
    };
}

const SKILL_A = { id: 's1', title: '呆猫图库', content: `呆猫用法说明。${'甲'.repeat(1200)}`, tags: [], updated_at: '', enabled: true, kind: 'skill' };
const SKILL_B = { id: 's2', title: '嘴替语料', content: `嘴替用法说明。${'乙'.repeat(800)}`, tags: [], updated_at: '', enabled: true, kind: 'skill' };
const SKILL_C = { id: 's3', title: '新点亮的技能', content: `新技能说明。${'丙'.repeat(300)}`, tags: [], updated_at: '', enabled: true, kind: 'skill' };

const BATCH = [
    entry(4, { userId: '1001', nickname: '甘甜', messageId: '101', text: '渔力全开有人玩吗' }),
    entry(3, { userId: '1002', nickname: '潇', messageId: '102', text: '你买了吗' }),
    entry(2, { userId: '1003', nickname: '寒愁洛', messageId: '103', text: '刚入了一份' }),
];

const TURN_OPTS = {
    botNickname: '汐音',
    chatId: 'g_955682835',
    stylePackId: 'groupie',
    memoryBlock: '<memory-recall>\n（轻量召回；别当圣旨念）· 人物 外界☆甘甜(1001)\n</memory-recall>',
};

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

try {
    // ---------------------------------------------------------------- 分层落位
    const s1 = newSession();
    const t1 = compose.composeTurn(CONFIG, s1, BATCH, [SKILL_A, SKILL_B], 0, TURN_OPTS);

    assert.ok(t1.systemPrompt.includes('<chat-facts>'), 'chat-facts 应进稳定 system');
    assert.ok(t1.systemPrompt.includes('群号：955682835'), 'chat-facts 应含群号');
    assert.ok(t1.systemPrompt.includes('群名：MK - Galgame交流群'), 'chat-facts 应含群名');
    assert.ok(t1.systemPrompt.includes('我的资历：新成员'), 'chat-facts 应含资历');
    assert.ok(t1.systemPrompt.includes('我的群身份：普通成员'), 'chat-facts 应含群身份');
    assert.ok(t1.systemPrompt.includes('我的入群：2026-01-06 12:21:05'), 'chat-facts 应含入群时间');
    assert.ok(/联网[：:]/.test(t1.systemPrompt), 'chat-facts 应含会话冻结的联网开关');
    assert.ok(/识图[：:]\s*(?:已|未)开启/.test(t1.systemPrompt), 'chat-facts 应含会话冻结的识图开关');
    assert.ok(t1.systemPrompt.includes('<skill-tree>'), 'skill-tree 应进稳定 system');
    assert.ok(t1.systemPrompt.includes('呆猫图库'), 'skill-tree 应含技能标题');
    assert.strictEqual(occurrences(t1.systemPrompt, '<skill-tree>'), 1, 'skill-tree 只能出现一次');
    assert.strictEqual(occurrences(t1.systemPrompt, '<chat-facts>'), 1, 'chat-facts 只能出现一次');

    // user turn：一律不再带 skill-tree / chat-facts / 引导句
    assert.ok(!t1.userContentExact.includes('<skill-tree>'), 'user turn 不应再有 skill-tree');
    assert.ok(!t1.userContentExact.includes('呆猫图库'), 'user turn 不应再灌技能正文');
    assert.ok(!t1.userContentExact.includes('以下 <skill-tree>'), '700 字符引导句应删除');
    assert.ok(!t1.userContentExact.includes('<chat-facts>'), 'chat-facts 不应进 user turn');

    // ---------------------------------------------------------------- host-state 瘦身
    const hostBlock = t1.userContentExact.match(/<host-state>([\s\S]*?)<\/host-state>/)?.[1] || '';
    assert.ok(hostBlock, 'user turn 仍应有 host-state');
    for (const keep of ['行为数 0-3', '建议条数', '沉默计数 1/5', '未艾特你']) {
        assert.ok(hostBlock.includes(keep), `host-state 应保留会变的事实「${keep}」`);
    }
    for (const gone of ['聊天：群聊', '群号：', '群名：', '我的资历', '我的群身份', '我的入群', '联网', '识图：已开启']) {
        assert.ok(!hostBlock.includes(gone), `host-state 不应再复述静态事实「${gone}」`);
    }
    assert.ok(!/建议条数 \d+（/.test(hostBlock), '建议条数应只留数值，解释归 PROTOCOL');
    assert.ok(hostBlock.length <= 420, `host-state 应控制在 420 字符内，实测 ${hostBlock.length}`);

    // 面板噪音总量：host-state + talk-graph + memory-recall
    const panelChars = ['host-state', 'talk-graph', 'memory-recall']
        .map((tag) => t1.userContentExact.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))?.[0]?.length || 0)
        .reduce((a, b) => a + b, 0);
    assert.ok(panelChars <= 1100, `turn 尾面板总量应不超过 1100 字符，实测 ${panelChars}`);

    // talk-graph：怎么读它的规则归稳定 system，本轮块里只放事实
    const graphBlock = t1.userContentExact.match(/<talk-graph>([\s\S]*?)<\/talk-graph>/)?.[1] || '';
    assert.ok(graphBlock, '多人批次应有 talk-graph');
    assert.ok(!graphBlock.includes('已经算好'), 'talk-graph 不应重复稳定 system 里的读法说明');
    assert.ok(!graphBlock.includes('别把推理念出来'), 'talk-graph 不应重复反念出来规则');

    // 受话人错位是 16 代最典型的翻车：别人互称「你」被当成在问自己，还反过来指责对方插嘴。
    // 结论按需强化：只有确实没人点你、且本批真出现了「你」时才补这一句。
    assert.ok(graphBlock.includes('结论 本批没有人在对你说话'), 'talk-graph 应给出确定性结论');
    assert.ok(graphBlock.includes('本批出现的「你」都不是指你'), '别人互称「你」时应补消歧句');

    // 有人只喊昵称（没 @、没引用）：不敢下这个断言，否则会把真正的点名压掉
    const nickCall = [
        entry(3, { userId: '1001', nickname: '甘甜', messageId: '301', text: '汐音 你在吗' }),
        entry(2, { userId: '1002', nickname: '潇', messageId: '302', text: '她可能在忙' }),
    ];
    const nickGraph = compose.composeTurn(CONFIG, newSession(), nickCall, [SKILL_A], 0, TURN_OPTS)
        .userContentExact.match(/<talk-graph>([\s\S]*?)<\/talk-graph>/)?.[1] || '';
    assert.ok(nickGraph, '喊昵称的批次仍应有 talk-graph');
    assert.ok(!nickGraph.includes('都不是指你'), '有人喊你昵称时不得断言「你」与你无关');

    // 被 @：结论要点名是谁在对你说话，且不补消歧句
    const atBotBatch = [
        entry(3, { userId: '1001', nickname: '甘甜', messageId: '401', text: '@汐音 你玩过吗', atQqs: ['2071521294'] }),
        entry(2, { userId: '1002', nickname: '潇', messageId: '402', text: '我也想问' }),
    ];
    const atGraph = compose.composeTurn(CONFIG, newSession(), atBotBatch, [SKILL_A], 0, TURN_OPTS)
        .userContentExact.match(/<talk-graph>([\s\S]*?)<\/talk-graph>/)?.[1] || '';
    assert.ok(/结论 对你说话的是 甘甜/.test(atGraph), '被 @ 时结论应点名受话来源');
    assert.ok(!atGraph.includes('都不是指你'), '被 @ 时不得补消歧句');

    // 单条消息：关系图是空话（被艾特已由 host-state 报），但 toBot 仍要算出来给沉默决策用
    const solo = [entry(1, { userId: '1001', nickname: '甘甜', messageId: '201', text: '@汐音 在吗', atQqs: ['2071521294'] })];
    const tSolo = compose.composeTurn(CONFIG, newSession(), solo, [SKILL_A], 0, TURN_OPTS);
    assert.ok(!tSolo.userContentExact.includes('<talk-graph>'), '单条消息不应挂 talk-graph');
    assert.deepStrictEqual(tSolo.talkGraph.toBot, ['1001'], '单条消息仍要算出「谁在对你说话」');
    assert.ok(tSolo.userContentExact.includes('本批艾特了你'), '被艾特的事实由 host-state 承担');

    // ---------------------------------------------------------------- 会话内冻结
    assert.ok(s1.frozen_skill_tree?.hash, '首轮应把技能树冻结进会话');
    const t2 = compose.composeTurn(CONFIG, s1, BATCH, [SKILL_A, SKILL_B], 0, TURN_OPTS);
    assert.strictEqual(t2.systemPrompt, t1.systemPrompt, 'KB 不变 → system 必须字节不变');

    // Top-M 顺序抖动不该改写已冻结文本（searchKnowledgeTopM 不看 query，只按 priority）
    const frozenText = s1.frozen_skill_tree.text;
    const t3 = compose.composeTurn(CONFIG, s1, BATCH, [SKILL_A, SKILL_B], 0, TURN_OPTS);
    assert.strictEqual(s1.frozen_skill_tree.text, frozenText, '同一份 KB 不应重复冻结');
    assert.strictEqual(t3.systemPrompt, t1.systemPrompt, 'system 跨轮稳定');

    // 技能增删：refrozen 一次，之后重新稳定
    const grow = compose.resolveFrozenSkillTree(s1, [SKILL_A, SKILL_B, SKILL_C]);
    assert.strictEqual(grow.refrozen, true, '技能增删应触发一次重新冻结');
    assert.ok(grow.text.includes('新点亮的技能'), '重新冻结应包含新技能');
    const t4 = compose.composeTurn(CONFIG, s1, BATCH, [SKILL_A, SKILL_B, SKILL_C], 0, TURN_OPTS);
    assert.notStrictEqual(t4.systemPrompt, t1.systemPrompt, '技能变更后 system 应变（一次 cache-reset）');
    assert.strictEqual(
        compose.resolveFrozenSkillTree(s1, [SKILL_A, SKILL_B, SKILL_C]).refrozen,
        false,
        '重新冻结后应立即恢复稳定',
    );

    // 无自定义技能：不留空标签
    const sEmpty = newSession();
    const tEmpty = compose.composeTurn(CONFIG, sEmpty, BATCH, [], 0, TURN_OPTS);
    assert.ok(!tEmpty.systemPrompt.includes('<skill-tree>'), '没有自定义技能时不应挂空 skill-tree');
    assert.ok(tEmpty.systemPrompt.includes('<chat-facts>'), 'chat-facts 与技能树无关，始终挂');

    // 私聊：只报聊天类型，不编群字段
    const sPrivate = newSession({ chat_type: 'private', group_id: '', group_name: '' });
    const privateFacts = compose.buildChatFactsBlock(sPrivate);
    assert.ok(privateFacts.includes('聊天：私聊'), '私聊应写明聊天类型');
    assert.ok(!privateFacts.includes('群号'), '私聊不应有群号');

    // 会话缺群号时按事件快照补齐，保证 chat-facts 不在首轮后变形
    const sBare = { messages: [], shut_up_streak: 0 };
    const tBare = compose.composeTurn(CONFIG, sBare, BATCH, [SKILL_A], 0, TURN_OPTS);
    assert.strictEqual(sBare.chat_type, 'group', '应从事件快照补出聊天类型');
    assert.ok(tBare.systemPrompt.includes('群号：955682835'), '应从事件快照补出群号');

    // ---------------------------------------------------------------- 预热 / 正式访问同一份 system
    const warm = compose.buildSessionSystemPrompt(CONFIG, s1, t4.systemCaps, {
        botNickname: TURN_OPTS.botNickname,
        stylePackId: TURN_OPTS.stylePackId,
    });
    assert.strictEqual(warm, t4.systemPrompt, '人设融合预热与正式访问必须同一份 system');

    // ---------------------------------------------------------------- 面板剥离（后台 / digest）
    const dirty = [
        '<memory-recall>\n· 人物 甘甜\n</memory-recall>',
        '<lorebook>\nNapCat\n</lorebook>',
        '<style-pack id="groupie">\n- 接梗 → 短接\n</style-pack>',
        '<chat-facts>\n群号：955682835\n</chat-facts>',
        '以下 <skill-tree> 是你本轮已装备的自定义技能；相关就释放。',
        '<skill-tree>\n◆ 呆猫图库\n用法\n</skill-tree>',
        '<host-state>\n行为数 0-3\n沉默计数 1/5\n</host-state>',
        '<talk-graph>\n结论 本批没有人在对你说话\n</talk-graph>',
        '<batch-messages>\n甘甜(1001) [msgid:101]：渔力全开有人玩吗\n</batch-messages>',
    ].join('\n\n');
    const cleanTurn = types.stripHostPanelBlocks(dirty).trim();
    for (const tag of types.HOST_PANEL_TAGS) {
        assert.ok(!cleanTurn.includes(`<${tag}`), `stripHostPanelBlocks 应剥掉 <${tag}>`);
    }
    assert.ok(!cleanTurn.includes('以下 <skill-tree>'), '引导句也应剥掉');
    assert.ok(cleanTurn.includes('<batch-messages>'), '真实群聊正文必须留下');
    assert.strictEqual(compose.stripHistoryUserMeta(dirty), cleanTurn, '两处剥离口径必须一致');

    const digest = compact.buildDigestContent([
        { role: 'user', content: dirty },
        { role: 'assistant', content: '<replies><msg>记住我不叫机器人</msg></replies>' },
    ]);
    for (const noise of ['<host-state>', '<skill-tree>', '<memory-recall>', '<talk-graph>', '<chat-facts>']) {
        assert.ok(!digest.includes(noise), `digest 不应固化面板噪音 ${noise}`);
    }
    assert.ok(digest.includes('渔力全开有人玩吗'), 'digest 应保留真实发言');

    console.log('verify-panel-layering: ok');
    console.log(JSON.stringify({
        systemChars: t1.systemPrompt.length,
        userTurnChars: t1.userContentExact.length,
        hostStateChars: hostBlock.length,
        turnPanelChars: panelChars,
        skillTreeChars: frozenText.length,
        skillTreeInSystem: 1,
    }, null, 2));
} catch (e) {
    fail(e);
}

cleanup();