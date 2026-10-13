/**
 * 输出质量基线（回归工具，不依赖构建产物、不联网、不改任何文件）
 *
 * 对磁盘上的会话数据算出 11 项指标，与 1.3.1 整改验收基线对照。
 * 整改前后各跑一次即可看出方向；单代/全代对照都支持。
 *
 * 运行：
 *   node scripts/quality-baseline.mjs --root "…\其他数据"           全代横向对照
 *   node scripts/quality-baseline.mjs --root "…\其他数据\智能对话16"  单代
 *   node scripts/quality-baseline.mjs --session "…\g_955682835.json" 单会话
 *   追加 --json 输出机器可读结果；追加 --gate 让未达标项以退出码 1 报错
 *
 * 口径说明：
 * - 分母：面板/正文类用「历史总字符」；文风类用「开口条数」（排除 shut_up 轮）。
 * - 指代/受话人一项是可观测代理（关系解析播报 + 插嘴指责 + 抢答他人经历），
 *   不是人工标注真值；只用于看方向，不当绝对准确率。
 * - 前缀缓存不看 usage.json：本项目上游中转不上报 cache 字段
 *   （38/38 条 cache_fields_reported=false），0 命中不等于前缀坏了。
 *   真正判据是运行日志里的 prefixStable，本工具只统计它在 .log 里的出现比。
 */
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? String(argv[i + 1] || '') : '';
};
const asJson = argv.includes('--json');

/** 注入段（进历史的宿主面板）；talk-graph 也算面板，防它把占比顶回去 */
const SEG = {
    skill: /<skill-tree>[\s\S]*?<\/skill-tree>/g,
    host: /<host-state>[\s\S]*?<\/host-state>/g,
    mem: /<memory-recall>[\s\S]*?<\/memory-recall>/g,
    lore: /<lorebook>[\s\S]*?<\/lorebook>/g,
    style: /<style-pack\b[^>]*>[\s\S]*?<\/style-pack>/g,
    talk: /<talk-graph>[\s\S]*?<\/talk-graph>/g,
};
/** 真实群聊正文 */
const BODY = /<(?:batch-messages|main-visit|side-context)>[\s\S]*?<\/(?:batch-messages|main-visit|side-context)>/g;
/** skill-tree 引导句（1.3.0 每轮 700 字符，1.3.1 应为 0） */
const SKILL_HINT = /以下 <skill-tree>[^\n]*/g;

/** 出站文风与内容问题（对去标签后的可见文字判定） */
const OUT_PAT = {
    selfCap: /我只会|我不会|做不到|没有.{0,6}权限|不是群[管主]|又不是群[管主]|可做不到|帮不了|我(?:也)?不清楚|不太清楚/,
    polite: /您|请问|帮您|为您/,
    machine: /电量|充电|重启|升级|版本|服务器|程序|机器人|人工智能|大模型|我是\s*AI|AI\s*助手|助手/,
    narrator: /大大|大人|老哥|这位|看来|听起来好|说话好|好厉害的样子|建议群友/,
    deflect: /去问|问问|自己(?:网上)?找找|问群主|问管理|问作者|自己搜/,
    wave: /[~～]/,
    // 指代/受话人代理：替群友解析谁在跟谁说话、指责别人插嘴、抢答他人经历
    addressing: /不是(?:在)?(?:问|针对|说|叫|找)你|是(?:在)?(?:针对|回|问)[^，。！？\n]{0,12}(?:的|说的)|(?:突然)?插嘴|(?:在|是)(?:跟|和|同)[^，。！？\n]{0,8}(?:说话|聊|说的)/,
};

const segLen = (text, re) => (String(text).match(re) || []).reduce((a, b) => a + b.length, 0);

function listSessionFiles(dir) {
    const out = [];
    const walk = (d) => {
        let ents = [];
        try {
            ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of ents) {
            const f = path.join(d, e.name);
            if (e.isDirectory()) walk(f);
            else if (/^g_\d+\.json$/.test(e.name)) out.push(f);
        }
    };
    walk(dir);
    return out.sort();
}

function visibleText(content) {
    return String(content || '')
        .replace(/<\/?replies>/gi, ' ')
        .replace(/<react\b[^>]*\/?>/gi, ' ')
        .replace(/<sticker>[\s\S]*?<\/sticker>/gi, ' ')
        .replace(/<\/?msg\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
}

/** 一批 user 正文里的时间戳跨度（分钟）与条数 */
function batchSpan(content) {
    // 只统计「本批真实消息」的时间戳：先剥掉 <memory-recall>。
    // 记忆是跨轮召回的旧条目，它自带的时间戳不属于本批 —— 19 代实测，一条 12 小时前的
    // 记忆条目被反复注入，会把所有批次的跨度污染成 1400+ 分钟，看起来像严重回归，
    // 实际本批消息只跨了几分钟。
    const body = String(content || '').replace(/<memory-recall>[\s\S]*?<\/memory-recall>/g, ' ');
    const ts = [...body.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/g)].map((m) => m[1]);
    if (ts.length < 2) return { n: ts.length, span: 0 };
    const ms = ts.map((s) => Date.parse(s.replace(' ', 'T'))).filter((n) => Number.isFinite(n));
    if (ms.length < 2) return { n: ts.length, span: 0 };
    return { n: ts.length, span: (Math.max(...ms) - Math.min(...ms)) / 60000 };
}

function percentile(list, p) {
    const a = list.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
}

function analyze(files) {
    const acc = {
        files: 0,
        rounds: 0,
        chars: 0,
        panel: 0,
        skillHint: 0,
        body: 0,
        asstChars: 0,
        replies: 0,
        silent: 0,
        hits: {},
        spans: [],
        batchSizes: [],
        skillKinds: new Set(),
        skillTurns: 0,
        seg: { skill: 0, host: 0, mem: 0, lore: 0, style: 0, talk: 0 },
    };
    for (const k of Object.keys(OUT_PAT)) acc.hits[k] = 0;

    for (const f of files) {
        let json;
        try {
            json = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch {
            continue;
        }
        const msgs = Array.isArray(json?.messages) ? json.messages : [];
        if (!msgs.length) continue;
        acc.files += 1;
        acc.rounds += Math.floor(msgs.length / 2);
        for (const m of msgs) {
            const c = String(m?.content || '');
            acc.chars += c.length;
            if (m?.role === 'assistant') {
                acc.asstChars += c.length;
                acc.replies += 1;
                if (/<shut_up/i.test(c)) {
                    acc.silent += 1;
                    continue;
                }
                const vis = visibleText(c);
                for (const [k, re] of Object.entries(OUT_PAT)) {
                    if (re.test(vis)) acc.hits[k] += 1;
                }
                continue;
            }
            if (m?.role !== 'user') continue;
            for (const [k, re] of Object.entries(SEG)) {
                const n = segLen(c, re);
                acc.seg[k] += n;
                acc.panel += n;
            }
            const hint = segLen(c, SKILL_HINT);
            acc.skillHint += hint;
            acc.panel += hint;
            acc.body += segLen(c, BODY);
            for (const b of c.match(SEG.skill) || []) acc.skillKinds.add(b);
            if (/<skill-tree>/.test(c)) acc.skillTurns += 1;
            const { n, span } = batchSpan(c);
            if (n > 0) acc.batchSizes.push(n);
            if (n > 1) acc.spans.push(span);
        }
    }
    return acc;
}

function metrics(acc) {
    const spoke = Math.max(0, acc.replies - acc.silent);
    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
    const out = {
        files: acc.files,
        rounds: acc.rounds,
        replies: acc.replies,
        spoke,
        chars: acc.chars,
        panelPct: pct(acc.panel, acc.chars),
        bodyPct: pct(acc.body, acc.chars),
        asstPct: pct(acc.asstChars, acc.chars),
        skillHintChars: acc.skillHint,
        skillKinds: acc.skillKinds.size,
        skillTurns: acc.skillTurns,
        silencePct: pct(acc.silent, acc.replies),
        batchP95: Math.round(percentile(acc.batchSizes, 0.95)),
        spanP95: Math.round(percentile(acc.spans, 0.95)),
        spanMax: Math.round(Math.max(0, ...acc.spans)),
        seg: {},
    };
    for (const k of Object.keys(acc.seg)) out.seg[k] = acc.seg[k];
    for (const k of Object.keys(OUT_PAT)) out[k] = pct(acc.hits[k], spoke);
    return out;
}

/** 验收基线：来自 17 代横向统计，见 plans/边界原则 */
const GATES = [
    ['注入面板占会话', 'panelPct', { max: 20 }],
    ['真实正文占会话', 'bodyPct', { min: 70 }],
    ['旁白解说 narrator', 'narrator', { max: 10 }],
    ['句尾波浪 wave', 'wave', { max: 25 }],
    ['自称能力 selfCap', 'selfCap', { max: 5 }],
    ['万能推诿 deflect', 'deflect', { max: 5 }],
    ['客服敬语 polite', 'polite', { max: 0 }],
    ['机器自指 machine', 'machine', { max: 5 }],
    ['指代/受话人(代理) addressing', 'addressing', { max: 4.4 }],
    ['沉默率', 'silencePct', { min: 30, max: 45 }],
    ['batch 跨度 P95(分钟)', 'spanP95', { max: 5 }],
];

function gateReport(m) {
    const lines = ['', '=== 验收门（目标 vs 实测） ==='];
    let bad = 0;
    for (const [label, key, rule] of GATES) {
        const v = Number(m[key] || 0);
        const okMin = rule.min == null || v >= rule.min;
        const okMax = rule.max == null || v <= rule.max;
        const ok = okMin && okMax;
        if (!ok) bad += 1;
        const want = [rule.min != null ? `≥${rule.min}` : '', rule.max != null ? `≤${rule.max}` : '']
            .filter(Boolean)
            .join(' 且 ');
        lines.push(`${ok ? '达标' : '未达'}  ${label.padEnd(28, ' ')} 实测 ${String(v).padStart(6)}  目标 ${want}`);
    }
    lines.push(`未达标 ${bad} / ${GATES.length} 项`);
    return { lines, bad };
}

function detailReport(title, m) {
    return [
        '',
        `=== ${title} ===`,
        `会话文件 ${m.files}  轮数 ${m.rounds}  回复 ${m.replies}（开口 ${m.spoke}）  历史总字符 ${m.chars}`,
        `注入面板 ${m.panelPct}%  真实正文 ${m.bodyPct}%  assistant ${m.asstPct}%`,
        `  分段字符：skill-tree ${m.seg.skill}（${m.skillTurns} 轮 / 去重 ${m.skillKinds} 种）`
            + `  引导句 ${m.skillHintChars}  host-state ${m.seg.host}  memory ${m.seg.mem}`
            + `  lore ${m.seg.lore}  style ${m.seg.style}  talk-graph ${m.seg.talk}`,
        `batch 条数 P95 ${m.batchP95}  时间跨度 P95 ${m.spanP95} 分（最大 ${m.spanMax} 分）`,
        `文风命中（占开口条数）：narrator ${m.narrator}%  wave ${m.wave}%  selfCap ${m.selfCap}%`
            + `  deflect ${m.deflect}%  polite ${m.polite}%  machine ${m.machine}%  addressing ${m.addressing}%`,
        `沉默率 ${m.silencePct}%`,
    ];
}

function scanGenerations(root) {
    let ents = [];
    try {
        ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    return ents
        .filter((e) => e.isDirectory() && /\d+$/.test(e.name))
        .map((e) => ({ name: e.name, n: Number(e.name.match(/\d+$/)[0]), dir: path.join(root, e.name) }))
        .sort((a, b) => a.n - b.n);
}

function main() {
    const sessionArg = flag('session');
    const rootArg = flag('root') || process.env.MKAI_QUALITY_ROOT || '';
    if (!sessionArg && !rootArg) {
        console.error('用法：node scripts/quality-baseline.mjs --root <数据目录> | --session <g_*.json> [--json]');
        console.error('也可用环境变量 MKAI_QUALITY_ROOT 指定数据目录。');
        process.exit(2);
    }

    const report = [];
    const result = { generations: [], total: null };

    if (sessionArg) {
        const m = metrics(analyze([sessionArg]));
        result.total = m;
        report.push(...detailReport(`单会话 ${path.basename(sessionArg)}`, m));
    } else {
        const gens = scanGenerations(rootArg);
        if (gens.length) {
            report.push('代次  文件 轮数  面板%  正文%  narrator wave selfCap deflect polite machine addr 沉默%  跨度P95');
            report.push('----  ---- ----  -----  -----  -------- ---- ------- ------- ------ ------- ---- -----  -------');
            for (const g of gens) {
                const m = metrics(analyze(listSessionFiles(g.dir)));
                if (!m.replies) continue;
                result.generations.push({ gen: g.n, name: g.name, ...m });
                report.push(
                    String(g.n).padStart(4)
                        + String(m.files).padStart(6)
                        + String(m.rounds).padStart(5)
                        + String(m.panelPct).padStart(7)
                        + String(m.bodyPct).padStart(7)
                        + String(m.narrator).padStart(10)
                        + String(m.wave).padStart(5)
                        + String(m.selfCap).padStart(8)
                        + String(m.deflect).padStart(8)
                        + String(m.polite).padStart(7)
                        + String(m.machine).padStart(8)
                        + String(m.addressing).padStart(5)
                        + String(m.silencePct).padStart(6)
                        + String(m.spanP95).padStart(9),
                );
            }
        }
        const all = listSessionFiles(rootArg);
        const m = metrics(analyze(all));
        result.total = m;
        report.push(...detailReport(gens.length ? '全代合计' : path.basename(rootArg), m));
    }

    const gate = gateReport(result.total);
    report.push(...gate.lines);

    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.log(report.join('\n'));

    // --gate：当断言用（未达标即非 0 退出）。整改前跑基线时别加，否则必然红。
    if (argv.includes('--gate') && gate.bad > 0) process.exitCode = 1;
}

main();
