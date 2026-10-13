/**
 * 内置 system 去重与字符预算验收（1.2 / 1.4）
 *
 * 用 esbuild 真实加载常量再统计，不做文本猜测。
 *   node scripts/verify-system-prompt.mjs            断言模式
 *   node scripts/verify-system-prompt.mjs --table    只打字符数对照表
 *
 * 断言口径：每条约束只能出现在一个段里（按"归属段"判定），
 * 段内重复不算违规（同一节里换句话说明属于正常表述）。
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

const types = await loadModule('src/auth/smart-chat-types.ts');
const knowledge = await loadModule('src/auth/smart-chat-knowledge.ts');
const safety = await loadModule('src/auth/smart-chat-safety.ts');
const image = await loadModule('src/auth/smart-chat-image.ts');
const tools = await loadModule('src/auth/smart-chat-tools.ts');
const stylePack = JSON.parse(
    fs.readFileSync(path.join(root, 'src/auth/style-packs/groupie.json'), 'utf8'),
);

const SEGMENTS = {
    SELF_LOCKED: types.SYSTEM_PROMPT_SELF_LOCKED,
    WHO_LOCKED: types.SYSTEM_PROMPT_WHO_LOCKED,
    BODY_LOCKED: types.SYSTEM_PROMPT_BODY_LOCKED,
    PROTOCOL: knowledge.PROTOCOL_SYSTEM_SUFFIX,
    FACTUALITY: safety.FACTUALITY_SYSTEM_SUFFIX,
    CHINA: safety.CHINA_SENSITIVE_SYSTEM_SUFFIX,
    STYLE_PACK: stylePack.examples.map((e) => `${e.situation} ${e.say}`).join('\n'),
};

/** 条件能力段：开关打开才挂，不算进常挂字符预算，但同样参与串段与语义检查 */
const CONDITIONAL = {
    IMAGE: image.IMAGE_RECOGNIZE_SYSTEM_SUFFIX,
    TOOLS: tools.TOOLS_SYSTEM_SUFFIX,
    FAKE_THINK: types.FAKE_THINK_SYSTEM_SUFFIX,
};
const ALL_SEGMENTS = { ...SEGMENTS, ...CONDITIONAL };

/** 约束 → 归属段 + 命中特征（出现在别的段里即违规） */
const OWNERSHIP = [
    { name: '自我认知锚（你就是这个人）', owner: 'SELF_LOCKED', re: /只有这一个自我|不是你要扮演/ },
    { name: '身份否定（不是客服/助手）', owner: 'SELF_LOCKED', re: /问答机|万能助手|系统功能号/ },
    { name: '反自我暴露（别自曝机器）', owner: 'SELF_LOCKED', re: /装傻或短怼|讲成一套系统|不许冒出/ },
    { name: '别主动念人设', owner: 'SELF_LOCKED', re: /别主动念人设|报功能菜单/ },
    { name: '代词绑定/认人', owner: 'PROTOCOL', re: /代词|绑本行|别人说的「我」|互称「你/ },
    { name: '反客服腔', owner: 'FACTUALITY', re: /客服腔|有什么需要帮忙|软客服/ },
    { name: '反旁白解说', owner: 'WHO_LOCKED', re: /旁白解说|围观复盘|围观解说|建议群友/ },
    { name: '禁止冒充作者', owner: 'WHO_LOCKED', re: /冒充插件|自称插件|我的插件/ },
    { name: '别念 host-state 口令', owner: 'PROTOCOL', re: /念给群友|复述节奏口令|禁止念/ },
    { name: '要图时文字最多一句', owner: 'PROTOCOL', re: /文字最多一句/ },
    { name: '先评定有没有必要回', owner: 'PROTOCOL', re: /先评定有没有必要回/ },
    { name: 'main-visit 主访优先', owner: 'PROTOCOL', re: /main-visit/ },
];

const table = Object.entries(SEGMENTS).map(([k, v]) => ({ seg: k, chars: v.length }));
const total = table.reduce((a, b) => a + b.chars, 0);

if (process.argv.includes('--table')) {
    console.log('段名               字符数');
    for (const row of table) console.log(`${row.seg.padEnd(18)} ${String(row.chars).padStart(6)}`);
    console.log(`${'合计'.padEnd(17)} ${String(total).padStart(6)}`);
    console.log('条件能力段（开关打开才挂，不计入合计）');
    for (const [k, v] of Object.entries(CONDITIONAL)) {
        console.log(`${k.padEnd(18)} ${String(v.length).padStart(6)}`);
    }
    removeTmpDir(tmpDir);
    process.exit(0);
}

if (process.argv.includes('--dump')) {
    // 人工比对用：按实际拼装顺序打全文（不含 chat-facts / skill-tree 这类会话态段）
    const persona = '你是群里的「{{BOT_NICK}}」：日常摸鱼的熟人损友。';
    process.stdout.write(
        types.assembleSystemPromptBase(persona)
        + SEGMENTS.PROTOCOL
        + `\n<style-pack>\n${SEGMENTS.STYLE_PACK}\n</style-pack>`
        + SEGMENTS.FACTUALITY
        + SEGMENTS.CHINA
        + `\n\n[开关打开才挂]\n${CONDITIONAL.TOOLS}${CONDITIONAL.IMAGE}\n`,
    );
    removeTmpDir(tmpDir);
    process.exit(0);
}

const problems = [];
for (const rule of OWNERSHIP) {
    const hits = Object.entries(ALL_SEGMENTS).filter(([, text]) => rule.re.test(text)).map(([k]) => k);
    if (!hits.includes(rule.owner)) {
        problems.push(`${rule.name}：归属段 ${rule.owner} 里找不到，约束被删干净了`);
    }
    const strays = hits.filter((h) => h !== rule.owner);
    if (strays.length) {
        problems.push(`${rule.name}：只该留在 ${rule.owner}，却还出现在 ${strays.join('、')}`);
    }
}
try {
    if (problems.length) console.error(problems.join('\n'));
    assert.strictEqual(problems.length, 0, `\n${problems.join('\n')}\n`);
} finally {
    if (problems.length) removeTmpDir(tmpDir);
}

// 语义零损失：这些事实必须还在（不管在哪段，含条件能力段）
const all = Object.values(ALL_SEGMENTS).join('\n');
try {
    for (const must of [
        '一个中国原则',
        'shut_up',
        'send_sticker',
        'react',
        'replies',
        'host-state',
        '资历',
        '群身份',
        '眼睛',
        '不确定',
        'Markdown',
        '技能树',
        // 1.3.1 去重时差点丢的两条：上限不是目标 / 旧 host-state 是过期快照
        '不是每次都要凑满',
        'host-state 只认本轮那一份',
        // 识别自动账号/AI（用户要求：不写死 QQ 名单，靠内置知识让模型自判）
        '官方机器人',
        '自动账号',
    ]) {
        assert.ok(all.includes(must), `语义丢失：内置 system 里应保留「${must}」`);
    }

    // 职责声明：讲清内置段与人设的分工，且不提人设里的具体词
    assert.ok(
        /不改写你的人设|不改写人设/.test(SEGMENTS.WHO_LOCKED),
        'WHO_LOCKED 开头应声明「宿主运行规则不改写人设」',
    );
    for (const seg of ['SELF_LOCKED', 'WHO_LOCKED', 'BODY_LOCKED']) {
        for (const forbidden of ['主人', '主播', '群友们都是']) {
            assert.ok(
                !SEGMENTS[seg].includes(forbidden),
                `内置段不得对人设称呼做系统级重解释（${seg} 出现了「${forbidden}」）`,
            );
        }
    }

    // 身份锚必须紧贴人设定义句：位置本身是约束，落到中段会被后面几千字挤掉
    const personaLine = '你是群里的「{{BOT_NICK}}」：验收用定义句。';
    const assembled = types.assembleSystemPromptBase(personaLine);
    const selfAt = assembled.indexOf(SEGMENTS.SELF_LOCKED);
    const whoAt = assembled.indexOf(SEGMENTS.WHO_LOCKED);
    const bodyAt = assembled.indexOf(SEGMENTS.BODY_LOCKED);
    assert.ok(assembled.startsWith('【你是谁】\n' + personaLine), '人设定义句仍应是第一句');
    assert.ok(selfAt > 0, '身份锚应拼进稳定 system');
    assert.ok(
        selfAt <= personaLine.length + 20,
        `身份锚应紧跟人设句（实测偏移 ${selfAt}，人设句 ${personaLine.length} 字）`,
    );
    assert.ok(selfAt < whoAt && whoAt < bodyAt, '顺序应为 身份锚 → 宿主运行规则 → 脾气/说话/输出');
    assert.ok(
        assembled.indexOf('【身份】') < assembled.indexOf('【脾气】'),
        '【身份】应排在【脾气】之前',
    );

    // 口径：total 只含常挂内置段（SELF/WHO/BODY/PROTOCOL/FACTUALITY/CHINA/STYLE_PACK），
    // 不含人设句，也不含 TOOLS/IMAGE 这类开关段。
    // 同口径的 1.3.0 基线 = WHO 296 + BODY 934 + PROTOCOL 1360 + FACTUALITY 1197 + CHINA 490 = 4277
    //（1.3.0 没有 SELF_LOCKED，也没把 style-pack 挂上稳定 system）。
    // 上调 HIGH 的原因（2026-xx 人格修正）：新增【玩梗】段（听不懂的梗不许装懂/现编）、
    // 温度规则（别人示弱/关心时不许甩脸）、认真问可三四拍说具体、style-pack 由 11 行到 12 行。
    // 这几条是行为修正，不是灌水；LOW 不动，HIGH 从 4400 提到 4900。
    // 再次上调（识别自动账号/AI）：用户明确不要写死 QQ 名单，改为在 PROTOCOL 教一条
    // 「认清真人 vs QQ官方机器人 / 接了AI的普通号」的内置知识，让模型自己判、不主动搭理机器人。
    // 这是行为新增（非灌水），HIGH 从 4900 提到 5150。
    // 再次上调（发语音能力）：用户要「让 AI 有发语音的能力、但默认仍打字」，在 PROTOCOL 教一条
    // 「<voice>短句</voice> 偶尔用」的输出协议（静态挂载、不按群改写，避免前缀缓存抖动）。
    // 这是能力新增（非灌水），HIGH 从 5150 提到 5300。
    // 再次上调（面板泄漏封堵）：实测「智能对话21」三连把 host-state 的场况观察当台词念出去
    // （「明明没人在对我说话，我就多嘴了～」等），根因是 PROTOCOL 的禁念清单只枚举了数字类字段。
    // 这里补一条场况类禁念 + 一条「不许把运行观察当内心独白」的硬约束，是行为修正（非灌水），
    // HIGH 从 5300 提到 5450。
    const LOW = 3600;
    const HIGH = 5450;
    assert.ok(
        total >= LOW && total <= HIGH,
        `内置 system 合计 ${total} 字符，应落在 ${LOW}-${HIGH}（同口径 1.3.0 为 4277）`,
    );
} finally {
    removeTmpDir(tmpDir);
}

console.log(`verify-system-prompt: 全部通过（合计 ${total} 字符）`);