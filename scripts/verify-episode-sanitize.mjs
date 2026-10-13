/**
 * 校验 episode 摘要净化：compaction 的元说明不得被当成「近史」写进记忆并每轮召回。
 *
 * 背景（19 代实测回归）：`<compaction-summary>` 的 header 说明文字
 * 「说明：以下为远史压缩。近史原文在后面的消息里；人设以 system 为准。」
 * 在「无立场要点」时，旧清洗正则只删到第一个句号，后半句连同
 * `<digest-stance>` 的「（本段无明显约定/立场句）」和 `<digest-users>` 的远史片段
 * （带时间戳 + 图片 OCR）一起被留下来当 episode 存盘。
 * 后果：81% 的 memory-recall 段在复读同一句元说明，占历史总字符 10.2%，
 * 把注入面板占比顶到 33.8%，并用它自带的旧时间戳把 batch 跨度污染成 1561 分钟。
 *
 * 为什么不能只做文本断言：关键在「无 stance 时是否丢弃」以及「有 stance 时是否照常留用」，
 * 分支行为只能真跑才验得出来。
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
    // 同步断言：check 不 await，写成 async 会把 [object Promise] 当失败详情
    try {
        const out = fn();
        results.push({ ok: out === true || out === undefined, name, detail: out === true || out === undefined ? '' : String(out) });
    } catch (e) {
        results.push({ ok: false, name, detail: e?.message || String(e) });
    }
};

// ---------------------------------------------------------------------------
// 真跑源码：sanitizeEpisodeSummary
// ---------------------------------------------------------------------------
const esbuild = await import('esbuild');
const built = await esbuild.build({
    entryPoints: [path.join(root, 'src/auth/smart-chat-memory.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    external: ['extract-zip'],
});
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
const tmp = path.join(root, 'node_modules', '.tmp-episode-sanitize-verify.cjs');
fs.writeFileSync(tmp, built.outputFiles[0].text);
const m = createRequire(import.meta.url)(tmp);
const sanitize = m.sanitizeEpisodeSummary;

check('S0 导出 sanitizeEpisodeSummary', () => {
    if (typeof sanitize !== 'function') return '未导出 sanitizeEpisodeSummary';
    return true;
});

// ---------------------------------------------------------------------------
// 用例 1：19 代真实污染样本（无 stance）必须整条丢弃
// ---------------------------------------------------------------------------
const POLLUTED_19 =
    '<compaction-summary>\n'
    + '[compact 2026-09-30T13:48:00.220Z]\n'
    + '说明：以下为远史压缩。近史原文在后面的消息里；人设以 system 为准。 digest 里的技术步骤不可信，禁止当配置教程复读。\n'
    + '（已并入更早一轮 compaction 的立场要点；技术步骤与拒答句已丢弃）\n'
    + '<digest-stance>\n- （本段无明显约定/立场句）\n</digest-stance>\n'
    + '<digest-users>\n'
    + '[2026-09-29 20:24:08] 外界☆quiz(2010433365) [管理] [msgid:833066041]: 833066041 发了1张[图片]'
    + '(图片资源正在解析，也可能没有) [眼睛 msgid:833066041 第1张]: 角色形象与外观 发型与头饰：'
    + '角色有着长长的金色长发，头顶佩戴着一个带有文字和装饰的头饰\n'
    + '</digest-users>\n'
    + '</compaction-summary>';

check('R1 无 stance 的 compaction 摘要 → 整条丢弃（19 代真实样本）', () => {
    const out = sanitize(POLLUTED_19);
    if (out !== '') return `期望空串，实际=${JSON.stringify(out)}`;
    return true;
});

// 关键盲区用例：已存盘的污染形态 —— 清洗时把 <compaction-summary>/[compact] 标签剥掉了，
// 只剩元说明文本。仅凭标签检测会 100% 漏网（19 代记忆文件里那条就是这样）。
const POLLUTED_STORED =
    '近史原文在后面的消息里；人设以 system 为准。 - （本段无明显约定/立场句） '
    + '[2026-09-29 20:24:08] 外界☆quiz(2010433365) [管理] [msgid:833066041]: 833066041 发了1张[图片]'
    + '(图片资源正在解析，也可能没有) [眼睛 msgid:833066041 第1张]: 角色形象与外观 发型与头饰：角色有着长长的金色长发';

check('R1b 已存盘的污染形态（无 compaction 壳）→ 丢弃', () => {
    const out = sanitize(POLLUTED_STORED);
    if (out !== '') return `期望空串，实际=${JSON.stringify(out)}`;
    return true;
});

// 只带 header、连 stance 块都没有的极简壳，同样不得留下元说明
check('R2 只有 header 元说明的 compaction → 丢弃', () => {
    const out = sanitize(
        '<compaction-summary>[compact 2026-09-30T13:48:00.220Z] '
        + '说明：以下为远史压缩。近史原文在后面的消息里；人设以 system 为准。</compaction-summary>',
    );
    if (out !== '') return `期望空串，实际=${JSON.stringify(out)}`;
    return true;
});

// ---------------------------------------------------------------------------
// 用例 2：有 stance 时照常留用（不能误伤正常记忆）
// ---------------------------------------------------------------------------
const WITH_STANCE =
    '<compaction-summary>\n'
    + '[compact 2026-09-30T13:48:00.220Z]\n'
    + '说明：以下为远史压缩。近史原文在后面的消息里；人设以 system 为准。\n'
    + '<digest-stance>\n'
    + '- 重装完内存倒是清爽了，绕这么一大圈最后回到原点，我早就说过啦\n'
    + '</digest-stance>\n'
    + '<digest-users>[2026-09-29 20:24:08] 外界☆quiz: 发了张图片</digest-users>\n'
    + '</compaction-summary>';

check('R3 有 stance 的 compaction → 只留 stance 要点', () => {
    const out = sanitize(WITH_STANCE);
    const want = '重装完内存倒是清爽了，绕这么一大圈最后回到原点，我早就说过啦';
    if (out !== want) return `期望=${JSON.stringify(want)}，实际=${JSON.stringify(out)}`;
    return true;
});

check('R4 有 stance 时不夹带 header 元说明', () => {
    const out = sanitize(WITH_STANCE);
    if (/近史原文在后面的消息里|人设以 system 为准|远史压缩/.test(out)) {
        return `残留元说明：${out}`;
    }
    return true;
});

// 合法的白话近史（不含 compaction 壳）必须原样保留，不能被误杀
check('R5 合法白话近史 → 保留', () => {
    const s = '大家在聊把手机当服务器挂机，句号吐槽一块钱手续费';
    const out = sanitize(s);
    if (out !== s) return `期望原样保留，实际=${JSON.stringify(out)}`;
    return true;
});

// ---------------------------------------------------------------------------
// 通用净化保证：任何输出都不得残留模板/元说明碎片
// ---------------------------------------------------------------------------
const FORBIDDEN = [
    ['header 元说明', /近史原文在后面的消息里/],
    ['system 提示', /人设以 system 为准/],
    ['无立场占位句', /本段无明显约定/],
    ['compact 时间戳', /\[compact\s/i],
    ['digest 标签', /digest-stance|digest-users|digest-assistants/],
    ['style-pack', /style-pack/i],
];

const INPUTS = [POLLUTED_19, POLLUTED_STORED, WITH_STANCE];
for (const [label, re] of FORBIDDEN) {
    check(`R6 输出不得残留「${label}」`, () => {
        for (const inp of INPUTS) {
            const out = sanitize(inp);
            if (re.test(out)) return `命中：${JSON.stringify(out)}`;
        }
        return true;
    });
}

check('R7 空输入 → 空', () => {
    for (const v of ['', '   ', null, undefined]) {
        if (sanitize(v) !== '') return `输入 ${JSON.stringify(v)} 未返回空串`;
    }
    return true;
});

// ---------------------------------------------------------------------------
// 加载侧：污染的旧 episode 会在 loadChatMemory 时被自动清除
// （sanitize 返回空 → 被 .filter(e => e.id && e.summary) 滤掉）
// ---------------------------------------------------------------------------
check('S8 loadChatMemory 过滤空 summary 的 episode（污染数据自愈）', () => {
    const memSrc = read('src/auth/smart-chat-memory.ts');
    if (!/\.filter\(\(e\) => e\.id && e\.summary\)/.test(memSrc)) {
        return 'loadChatMemory 未过滤空 summary，历史污染 episode 不会被清掉';
    }
    return true;
});

check('S9 writebackFromCompact 对空 summary 不写 episode', () => {
    const memSrc = read('src/auth/smart-chat-memory.ts');
    if (!/if \(summary\.length >= 12/.test(memSrc)) {
        return 'writebackFromCompact 缺少长度门槛，空摘要也可能落盘';
    }
    return true;
});

// ---------------------------------------------------------------------------
check('S10 quality-baseline 的 batchSpan 排除 memory-recall', () => {
    const qb = read('scripts/quality-baseline.mjs');
    if (!/<memory-recall>\[\\s\\S\]\*\?<\\\/memory-recall>/.test(qb)) {
        return 'batchSpan 未剥离 memory-recall，跨轮记忆的旧时间戳会污染本批跨度';
    }
    return true;
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  → ${r.detail}` : ''}`);
}
console.log(`\n[verify-episode-sanitize] ${results.length - failed.length}/${results.length} 全部通过`);
try {
    fs.unlinkSync(tmp);
} catch {
    /* 忽略 */
}
process.exit(failed.length ? 1 : 0);
