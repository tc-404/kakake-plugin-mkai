/**
 * 失败恢复与安全边界验收（行为级，加载真实源码）
 *
 * 为什么单独有这一个脚本：本仓大部分 verify-*.mjs 断言的是**源码文本**
 * （`src.includes('xxx')`）或内联复刻的逻辑，改阈值/换分支/删守卫都能通过。
 * 这个脚本走另一条路：用 esbuild 把真实 TS 打成临时 ESM 再 import，
 * 用假上游 / 假宿主真跑一遍，断言**可观测行为**。
 *
 * 覆盖：
 *   ① 上游失败（连接被拒 / 空响应）不再丢批：整批放回缓冲 + 指数退避重试
 *      - @ 触发可穿透退避，但连续失败 ≥3 次后不再穿透（不打雪崩）
 *      - 退避期间 leftover 不再触发「立刻强制重试」（否则退避形同虚设）
 *   ② 上游「返头后 body 挂着不结束」被同一个截止时间中止（不再是永久挂着）
 *   ③ chatId / fingerprint 路径穿越：data-fs 层拒绝越界；面板路由回 400
 *      且不会删到数据目录之外的文件
 *   ④ data-fs 原子写（不留 .tmp）；writeB 遇坏 JSON 留档备份而不是清空同文件其它键
 *   ⑤ 已装载的反应延迟不被 scheduleFlush 重抽覆盖
 *   ⑥ 上下文触顶恢复对所有厂商生效（不再只在英伟达分支里）
 *
 * 运行：node scripts/verify-failure-recovery.mjs
 */
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
// 临时产物放仓库 node_modules 下：bundle 里 `external: ['extract-zip']` 仍是裸导入，
// 放 os.tmpdir() 会解析不到包（父链上没有 node_modules）。
const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-recovery-'));

async function loadModule(relTsPath) {
    const outfile = path.join(tmpDir, `${path.basename(relTsPath, '.ts')}-${Math.random().toString(36).slice(2, 7)}.mjs`);
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

let passed = 0;
const failures = [];
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failures.push([name, e]);
        console.log(`  ✗ ${name}\n      ${e.message}`);
    }
}

function tmpData(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `mkai-data-${tag}-`));
}

// ---------------------------------------------------------------------------
// 载入真实模块
// ---------------------------------------------------------------------------
const flushMod = await loadModule('src/auth/smart-chat-flush.ts');
const cfgMod = await loadModule('src/auth/smart-chat-config.ts');
const bufferMod = await loadModule('src/auth/smart-chat-buffer.ts');
const sessionMod = await loadModule('src/auth/smart-chat-session.ts');
const providerMod = await loadModule('src/auth/smart-chat-provider.ts');
const dataFs = await loadModule('src/lib/data-fs.ts');
const typesMod = await loadModule('src/auth/smart-chat-types.ts');
const webMod = await loadModule('src/auth/smart-chat-web.ts');

const SMART_CHAT_ROOT = typesMod.SMART_CHAT_ROOT;

function makeRuntime(dataPath) {
    dataFs.setDataPath(dataPath);
    const logs = [];
    const logger = {
        info: (...a) => logs.push(a.map(String).join(' ')),
        warn: (...a) => logs.push(a.map(String).join(' ')),
        error: (...a) => logs.push(a.map(String).join(' ')),
    };
    dataFs.bindLogger(logger);
    const sent = [];
    const deps = {
        readA: (f) => dataFs.readA(f),
        writeA: (f, c) => dataFs.writeA(f, c),
        readB: (f, k, d) => dataFs.readB(f, k, d),
        writeB: (f, k, v) => dataFs.writeB(f, k, v),
        getDataPath: () => dataPath,
        logger,
        发消息: async (_ev, segs) => {
            sent.push(segs);
            return { status: 'ok', retcode: 0, data: { message_id: '1' } };
        },
        设消息表情: async () => ({ status: 'ok', retcode: 0 }),
        eventUserTextFromSegments: () => '',
        段_文本: (t) => ({ type: 'text', data: { text: t } }),
        段_图片: (f) => ({ type: 'image', data: { file: f } }),
        段_艾特: (q) => ({ type: 'at', data: { qq: q } }),
        段_引用: (id) => ({ type: 'reply', data: { id } }),
        botApi: async () => ({ status: 'ok', retcode: 0, data: {} }),
        isKakakeLikeFramework: () => true,
        resolveApiTimeoutMs: () => 5000,
    };
    return { deps, logs, sent, logText: () => logs.join('\n') };
}

function writeConfig(deps, patch) {
    const cfg = {
        ...cfgMod.defaultSmartChatConfig(),
        vendor: 'deepseek',
        model: 'deepseek-v4-flash',
        api_key: 'sk-verify-000000000000',
        base_url: 'http://127.0.0.1:1/v1',
        balance_url: '',
        random_wait_enabled: false,
        tools_enabled: false,
        model_rotation_enabled: false,
        ...patch,
    };
    deps.writeA(`${SMART_CHAT_ROOT}config.json`, JSON.stringify(cfg, null, 2));
    return cfg;
}

function pushBatch(deps, chatId, text, extra = {}) {
    const now = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const time = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    bufferMod.appendChatBuffer(deps, chatId, {
        userId: '111',
        nickname: '测试',
        text,
        time,
        messageId: extra.messageId || `m${Math.random().toString(36).slice(2, 8)}`,
        atQqs: extra.atQqs,
        eventSnapshot: {
            message_type: 'group',
            group_id: chatId.replace(/^g_/, ''),
            user_id: '111',
            self_id: '999',
            message_id: extra.messageId || 'm1',
        },
    });
}

// ---------------------------------------------------------------------------
// ① 失败不丢批
// ---------------------------------------------------------------------------
console.log('\n① 上游失败不再丢批（放回缓冲 + 退避重试）');

const dpA = tmpData('fail');
const rtA = makeRuntime(dpA);
writeConfig(rtA.deps, {});
pushBatch(rtA.deps, 'g_123456', '在吗', { atQqs: ['999'], messageId: 'm-fail-1' });

await check('连接被拒后整批消息仍在缓冲里', async () => {
    await flushMod.flushChat(rtA.deps, 'g_123456');
    const back = bufferMod.loadChatBuffer(rtA.deps, 'g_123456');
    assert.strictEqual(back.length, 1, `缓冲应保留 1 条，实际 ${back.length}`);
});
await check('失败后进入退避窗口并挂上重试计时', async () => {
    assert.ok(flushMod.flushRetryDelayMs('g_123456') > 0, '应处于退避中');
    assert.ok(/已放回缓冲/.test(rtA.logText()), '日志应说明已放回缓冲');
    assert.ok(/退避/.test(rtA.logText()), '日志应有退避字样');
});
await check('退避中普通触发不重打上游，且不覆盖已装载计时', async () => {
    const before = flushMod.chatTimers.get('g_123456')?.reactAt || 0;
    flushMod.scheduleFlush(rtA.deps, 'g_123456');
    const state = flushMod.chatTimers.get('g_123456');
    assert.ok(state && state.reactAt >= before, '计时不得被提前/丢弃');
});
await check('@ 可穿透退避，但连续失败后退避变长（不打雪崩）', async () => {
    const first = flushMod.flushRetryDelayMs('g_123456');
    await flushMod.flushChat(rtA.deps, 'g_123456', { force: true });
    const after = flushMod.flushRetryDelayMs('g_123456');
    assert.ok(after >= first, `退避应增长：${first} → ${after}`);
    await flushMod.flushChat(rtA.deps, 'g_123456', { force: true });
    await flushMod.flushChat(rtA.deps, 'g_123456', { force: true });
    assert.ok(
        bufferMod.loadChatBuffer(rtA.deps, 'g_123456').length >= 1,
        '多次失败后消息仍必须在缓冲里',
    );
});
flushMod.resetFlushTimers();

// ---------------------------------------------------------------------------
// ② body 读取截止时间
// ---------------------------------------------------------------------------
console.log('\n② 响应体读取纳入同一个截止时间');

const stalled = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
});
await new Promise((r) => stalled.listen(0, '127.0.0.1', r));

await check('返头后 body 不结束 → 被中止（不再永久挂着）', async () => {
    const url = `http://127.0.0.1:${stalled.address().port}/v1/chat/completions`;
    const t0 = Date.now();
    await assert.rejects(
        () => providerMod.fetchTextWithDeadline(url, { method: 'POST', body: '{}' }, 1200),
        (e) => String(e?.name || '') === 'AbortError' || /abort/i.test(String(e?.message || '')),
    );
    assert.ok(Date.now() - t0 < 8000, '应在截止时间附近结束');
});
stalled.closeAllConnections?.();
await new Promise((r) => stalled.close(r));

await check('正常响应仍能拿到 body', async () => {
    const good = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });
    await new Promise((r) => good.listen(0, '127.0.0.1', r));
    const r = await providerMod.fetchTextWithDeadline(
        `http://127.0.0.1:${good.address().port}/x`,
        { method: 'POST', body: '{}' },
        3000,
    );
    assert.strictEqual(r.text, '{"ok":true}');
    good.closeAllConnections?.();
    await new Promise((r2) => good.close(r2));
});

// ---------------------------------------------------------------------------
// ③ 路径穿越
// ---------------------------------------------------------------------------
console.log('\n③ chatId / fingerprint 路径穿越被拒');

const dpC = tmpData('trav');
const rtC = makeRuntime(dpC);
const outside = path.join(dpC, '..', `mkai-outside-${Date.now()}.json`);
fs.writeFileSync(outside, JSON.stringify({ secret: 'x' }), 'utf-8');

await check('data-fs 拒绝越界读写', async () => {
    assert.strictEqual(dataFs.readA('../evil.json'), '');
    const target = path.join(dpC, '..', `mkai-escape-${Date.now()}.json`);
    const rel = path.relative(dpC, target).replace(/\\/g, '/');
    assert.strictEqual(dataFs.writeA(rel, 'x'), false);
    assert.ok(!fs.existsSync(target), '越界文件不应被创建');
});
await check('session/buffer/memory 路径段被净化，落盘不越界', async () => {
    const id = '../../../../evil';
    sessionMod.loadSessionAtFingerprint(rtC.deps, id, 'aaaa');
    bufferMod.saveChatBuffer(rtC.deps, id, []);
    const files = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else files.push(full);
        }
    };
    walk(dpC);
    assert.ok(files.length > 0, '应有文件落盘');
    assert.ok(
        files.every((f) => path.resolve(f).startsWith(path.resolve(dpC) + path.sep)),
        '所有落盘文件都必须在 dataPath 内',
    );
});

const routes = { get: new Map(), post: new Map() };
const wrapPath = (p) => (p.startsWith('/') ? `/mkai${p}` : `/mkai/${p}`);
const rtW = makeRuntime(tmpData('web'));
writeConfig(rtW.deps, {});
const fakeRouter = { get: (p, h) => routes.get.set(p, h), post: (p, h) => routes.post.set(p, h) };
webMod.registerSmartChatWebGetRoutes(fakeRouter, wrapPath, rtW.deps, rtW.deps.logger);
webMod.registerSmartChatWebPostRoutes(fakeRouter, wrapPath, rtW.deps, rtW.deps.logger);

function callRoute(kind, p, req) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            payload: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.payload = body;
                resolve(this);
                return this;
            },
            setHeader() {},
        };
        routes[kind].get(p)({ query: {}, body: {}, on: () => {}, ...req }, res);
    });
}

await check('GET /smart-chat/session 拒绝穿越 chatId（400）', async () => {
    const res = await callRoute('get', wrapPath('/smart-chat/session'), {
        query: { chatId: '../../../../智能对话/config' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload?.message, 'invalid_chatId');
});
await check('POST /session/clear-others 拒绝穿越且不删外部文件', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/session/clear-others'), {
        body: { chatId: '../../evil', fingerprint: 'aaaa' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(fs.existsSync(outside), '外部文件必须还在');
});
await check('POST /session/clear 拒绝穿越 fingerprint（400）', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/session/clear'), {
        body: { chatId: 'g_123', fingerprint: '../../../../etc' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload?.message, 'invalid_fingerprint');
});

// 已存密钥不得发往调用方给的 base_url
const seenAuth = [];
const upstream = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization || ''));
    req.on('data', () => {});
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'x',
            choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
    });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const localBase = `http://127.0.0.1:${upstream.address().port}/v1`;
writeConfig(rtW.deps, { base_url: localBase, api_key: 'sk-stored-secret' });

await check('base_url 与已存端点不同 → /probe 拒绝且不外发密钥', async () => {
    const before = seenAuth.length;
    const res = await callRoute('post', wrapPath('/smart-chat/probe'), {
        body: { vendor: 'deepseek', base_url: 'https://evil.example/v1', model: 'x' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload?.message, 'api_key_required_for_custom_base_url');
    assert.strictEqual(seenAuth.length, before, '不应发出任何请求');
});
await check('base_url 与已存端点相同 → 照旧代入已存密钥', async () => {
    await callRoute('post', wrapPath('/smart-chat/probe'), {
        body: { vendor: 'deepseek', base_url: localBase, model: 'deepseek-v4-flash' },
    });
    assert.strictEqual(seenAuth.at(-1), 'Bearer sk-stored-secret');
});
await check('/models 同样规则：端点不同 → 400 且不外发', async () => {
    const before = seenAuth.length;
    const res = await callRoute('post', wrapPath('/smart-chat/models'), {
        body: { vendor: 'deepseek', base_url: 'https://evil.example/v1' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload?.message, 'api_key_required_for_custom_base_url');
    assert.strictEqual(seenAuth.length, before, '不应发出任何请求');
});
await check('面板把 base_url 改到新主机且密钥是掩码 → 400', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/config'), {
        body: { base_url: 'https://evil.example/v1', api_key: 'sk-s…cret' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload?.message, 'base_url_host_change_requires_api_key');
});
await check('显式重填 api_key 时允许换主机（不误伤正常配置）', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/config'), {
        body: { base_url: 'https://evil.example/v1', api_key: 'sk-brand-new-key' },
    });
    assert.strictEqual(res.statusCode, 200);
});

// 更深一层：自定义厂商档案里的 base_url 也是端点；「填一个无关档案的 key」不能当通行证
const customBody = (baseUrl, key, extra) => ({
    vendor: 'custom_test',
    base_url: localBase,
    model: 'x',
    custom_vendors: [{
        id: 'custom_test',
        name: '测试线路',
        base_url: baseUrl,
        model: 'x',
        api_key: key,
    }, ...(extra || [])],
});

await check('先存一个自定义厂商档案（带密钥）', async () => {
    writeConfig(rtW.deps, {
        base_url: localBase,
        api_key: 'sk-stored-secret',
        custom_vendors: [{
            id: 'custom_test',
            name: '测试线路',
            base_url: localBase,
            model: 'x',
            api_key: 'sk-custom-stored',
        }],
    });
    assert.strictEqual(rtW.deps.readB(`${SMART_CHAT_ROOT}config.json`, 'api_key'), 'sk-stored-secret');
});
await check('改自定义厂商档案端点（密钥仍掩码）→ 400', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/config'), {
        body: customBody('https://evil.example/v1', 'sk-c…ored', []),
    });
    assert.strictEqual(res.statusCode, 400, `应拒绝，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
    assert.match(String(res.payload?.message || ''), /host_change_requires_api_key/);
});
await check('给别的档案填真密钥不能当通行证 → 仍 400', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/config'), {
        body: {
            ...customBody('https://evil.example/v1', 'sk-c…ored', [{
                id: 'custom_other',
                name: '无关线路',
                base_url: 'https://other.example/v1',
                model: 'x',
                api_key: 'sk-fresh-decoy',
            }]),
        },
    });
    assert.strictEqual(res.statusCode, 400, `应拒绝，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
});
await check('该档案自己重填密钥 → 放行', async () => {
    const res = await callRoute('post', wrapPath('/smart-chat/config'), {
        body: customBody('https://evil.example/v1', 'sk-custom-brand-new', []),
    });
    assert.strictEqual(res.statusCode, 200, `应放行，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
});
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));

// ---------------------------------------------------------------------------
// ④ 原子写 / writeB
// ---------------------------------------------------------------------------
console.log('\n④ 原子写与 writeB 坏文件处理');

const dpD = tmpData('fs');
const rtD = makeRuntime(dpD);
await check('writeB 保留同文件其它键', async () => {
    dataFs.writeA('开关.json', JSON.stringify({ g1: '开启', g2: '关闭' }, null, 2));
    dataFs.writeB('开关.json', 'g3', '开启');
    assert.strictEqual(dataFs.readB('开关.json', 'g1'), '开启');
    assert.strictEqual(dataFs.readB('开关.json', 'g2'), '关闭');
    assert.strictEqual(dataFs.readB('开关.json', 'g3'), '开启');
});
await check('writeB 遇坏 JSON 留档备份 + 记错误日志', async () => {
    dataFs.writeA('坏.json', '{ this is not json');
    assert.strictEqual(dataFs.writeB('坏.json', 'a', 1), true);
    const files = fs.readdirSync(dpD);
    assert.ok(files.some((f) => f.startsWith('坏.json.corrupt-')), `应有备份：${files.join(',')}`);
    assert.ok(/损坏/.test(rtD.logText()), '应记录损坏日志');
});
await check('原子写不残留 .tmp', async () => {
    for (let i = 0; i < 5; i += 1) dataFs.writeA(`x${i}.json`, JSON.stringify({ i }));
    assert.deepStrictEqual(fs.readdirSync(dpD).filter((f) => f.endsWith('.tmp')), []);
});

// ---------------------------------------------------------------------------
// ⑤ 反应延迟不被覆盖 / ⑥ 触顶恢复不挑厂商
// ---------------------------------------------------------------------------
console.log('\n⑤ 已装载的反应延迟不被覆盖');

const rtE = makeRuntime(tmpData('sched'));
writeConfig(rtE.deps, {});
pushBatch(rtE.deps, 'g_777', '凑满一批');
flushMod.scheduleReactionFlush(rtE.deps, 'g_777');
const armed = flushMod.chatTimers.get('g_777')?.reactAt || 0;
await check('scheduleFlush 不重抽、不覆盖已装载的反应延迟', async () => {
    assert.ok(armed > Date.now(), '应先装载 5–45s 反应延迟');
    flushMod.scheduleFlush(rtE.deps, 'g_777');
    assert.strictEqual(flushMod.chatTimers.get('g_777')?.reactAt, armed);
    assert.ok(/不重抽等待/.test(rtE.logText()), '应记录不重抽等待');
});
flushMod.resetFlushTimers();

console.log('\n⑥ 上下文触顶恢复对所有厂商生效');

const rtF = makeRuntime(tmpData('overflow'));
let upstreamCalls = 0;
const overflowServer = http.createServer((req, res) => {
    upstreamCalls += 1;
    req.on('data', () => {});
    req.on('end', () => {
        if (upstreamCalls === 1) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens" } }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'x',
            choices: [{ index: 0, message: { role: 'assistant', content: '<msg>收到啦</msg>' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
    });
});
await new Promise((r) => overflowServer.listen(0, '127.0.0.1', r));
writeConfig(rtF.deps, {
    base_url: `http://127.0.0.1:${overflowServer.address().port}/v1`,
    api_key: 'sk-overflow',
});
pushBatch(rtF.deps, 'g_888', '超长上下文测试', { atQqs: ['999'], messageId: 'ov-1' });

await check('非英伟达厂商触顶 → compact 后重试并成功开口', async () => {
    await flushMod.flushChat(rtF.deps, 'g_888');
    assert.ok(upstreamCalls >= 2, `应重试，实际上游请求 ${upstreamCalls} 次`);
    const texts = rtF.sent.flat().filter((s) => s?.type === 'text').map((s) => s.data.text);
    assert.ok(texts.includes('收到啦'), `应发出重试成功的回复，实际 ${JSON.stringify(texts)}`);
});
overflowServer.closeAllConnections?.();
await new Promise((r) => overflowServer.close(r));
flushMod.resetFlushTimers();

try { fs.unlinkSync(outside); } catch { /* ignore */ }
try { removeTmpDir(tmpDir); } catch { /* ignore */ }

console.log(`\nverify-failure-recovery: 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    for (const [name, e] of failures) console.log(` - ${name}: ${e.message}`);
    process.exit(1);
}
process.exit(0);
