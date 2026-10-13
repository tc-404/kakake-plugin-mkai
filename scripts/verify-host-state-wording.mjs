/**
 * host-state / talk-graph 的场况文案必须是「机器字段」，不能是完整中文句 + 第二人称「你」。
 *
 * 起因（智能对话 21 实测）：旧文案 `本批没人在对你说话：接不接都行` 本身就是一句
 * 可以直接当台词的中文陈述句，弱模型改两个词就念出去，实测三连：
 *   「～ 明明没人在对我说话，我怎么能不凑个热闹呀～」
 *   「明明没人在对我说话，我就多嘴了～」
 *   「～ 明明不说我，我就当你跟我开玩笑了～」
 * `场况: 旁听（无指向本账号）` 这种「字段: 值」形态念出来不像人话，模型无从改写。
 *
 * 本脚本只做源码文本约束，不跑 esbuild —— 图的是快与稳，谁把人话加回来谁红。
 */
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const composeSrc = read('src/auth/smart-chat-compose.ts');
const silenceSrc = read('src/auth/smart-chat-silence.ts');
const sceneSrc = read('src/auth/smart-chat-scene.ts');
const knowledgeSrc = read('src/auth/smart-chat-knowledge.ts');

/**
 * 只取「真正会进 host-state / talk-graph 的字符串字面量」：
 * 各种 push('…') 与 conclusion = / += '…'。
 * 不看整份源码，否则注释里引用旧文案（说明为什么改）会被误判成没改。
 */
function hostStateLiterals(src) {
    const out = [];
    const pats = [
        /\w*[Ll]ines\.push\(\s*['"`]([^'"`]*)['"`]\s*\)/g,
        /hostSilenceHints\.push\(\s*['"`]([^'"`]*)['"`]\s*\)/g,
        /hostLines\.push\(\s*['"`]([^'"`]*)['"`]\s*\)/g,
        /conclusion\s*=\s*['"`]([^'"`]*)['"`]/g,
        /conclusion\s*\+=\s*['"`]([^'"`]*)['"`]/g,
    ];
    for (const re of pats) {
        for (const m of src.matchAll(re)) out.push(m[1]);
    }
    return out;
}

const literals = [
    ...hostStateLiterals(composeSrc).map((s) => ({ file: 'compose.ts', s })),
    ...hostStateLiterals(silenceSrc).map((s) => ({ file: 'silence.ts', s })),
    ...hostStateLiterals(sceneSrc).map((s) => ({ file: 'scene.ts', s })),
];

assert.ok(literals.length >= 8, `场况文案字面量太少（${literals.length}），抽取正则可能失效了`);

// ---------------------------------------------------------------- 1) 旧的人话文案必须绝迹
const BANNED = [
    '没人在对你说话',
    '没人在对我说话',
    '无人点名你',
    '未艾特你',
    '本批艾特了你',
    '对你说话的是',
    '都不是指你',
    '含对你提问',
];
for (const { file, s } of literals) {
    for (const bad of BANNED) {
        assert.ok(
            !s.includes(bad),
            `${file} 仍在用可复读的人话文案「${bad}」→ ${JSON.stringify(s)}`,
        );
    }
}

// ---------------------------------------------------------------- 2) 场况类字段不得带第二人称
// 场况/判决是宿主在给机器报数；带「你」等于把一句中文陈述句塞进上下文，弱模型直接复读。
const FIELD_MARKS = ['场况', '判决', '结论', '艾特', '点名', '拓扑', '次访问指向本账号'];
for (const { file, s } of literals) {
    if (!FIELD_MARKS.some((k) => s.includes(k))) continue;
    assert.ok(
        !/[你您]/.test(s),
        `${file} 场况字段里带了第二人称「你」→ ${JSON.stringify(s)}（改成「本账号」这类中性说法）`,
    );
}

// ---------------------------------------------------------------- 3) 新字段必须真的在
const REQUIRED = [
    { src: composeSrc, file: 'compose.ts', needle: '艾特: 有' },
    { src: composeSrc, file: 'compose.ts', needle: '艾特: 无' },
    { src: composeSrc, file: 'compose.ts', needle: '结论 指向本账号: 无' },
    { src: composeSrc, file: 'compose.ts', needle: '结论 指向本账号: ${who}' },
    { src: composeSrc, file: 'compose.ts', needle: '批内「你」均非指向本账号' },
    { src: silenceSrc, file: 'silence.ts', needle: '场况: 旁听（无指向本账号）' },
    { src: silenceSrc, file: 'silence.ts', needle: '判决: 本轮不开口' },
    { src: silenceSrc, file: 'silence.ts', needle: '判决: 接不接都行' },
    { src: sceneSrc, file: 'scene.ts', needle: '点名: 无' },
    { src: sceneSrc, file: 'scene.ts', needle: '拓扑: 两人互指' },
];
for (const { src, file, needle } of REQUIRED) {
    assert.ok(src.includes(needle), `${file} 缺少机器字段文案「${needle}」`);
}

// ---------------------------------------------------------------- 4) 禁念清单要覆盖场况类
// 旧清单只枚举了数字类（行为数/建议条数/沉默计数），漏了陈述句类 → 那正是泄漏源。
const proto = knowledgeSrc.slice(
    knowledgeSrc.indexOf('PROTOCOL_SYSTEM_SUFFIX'),
    knowledgeSrc.indexOf('function upsertBuiltin'),
);
assert.ok(proto.length > 500, '没抓到 PROTOCOL_SYSTEM_SUFFIX 正文，脚本要跟着改');

for (const must of ['场况', '判决', '指向本账号', '次访问条数']) {
    assert.ok(proto.includes(must), `禁念清单没提到场况字段「${must}」`);
}
// 硬性封死「把观察当内心独白」的句式（21 实测三连就是这么来的）
for (const must of ['内心独白', '没人跟我说话', '我凑个热闹']) {
    assert.ok(proto.includes(must), `禁念清单没点名禁止句式「${must}」`);
}
// 有人点名时必须仍以旁人身份接话，别把代词规则一起删了
assert.ok(proto.includes('指向本账号: 无'), '代词规则仍须引用 talk-graph 的新字段名');

console.log('ok  host-state / talk-graph 场况文案均为机器字段，禁念清单已覆盖场况类与内心独白句式');
