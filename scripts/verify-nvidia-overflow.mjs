/**
 * 英伟达高上下文预设 + 触顶 compact 恢复
 *
 * 原实现把 nvidiaContextBudget / estimateMessagesTokens / estimateTextTokens /
 * isContextOverflowError / isDigestMessage / buildDigestContent /
 * forceCompactForOverflow 七个函数在本文件里内联复刻 —— 复刻件还比真实现旧：
 *   · estimateMessagesTokens 漏了 tool_calls 计费
 *   · nvidiaContextBudget 漏了 nemotron-3.5-lightning / nemotron-3-nano / llama-3.1-70b 档
 *   · isDigestMessage 漏了 role==='user' 与「误包普通回合」判定
 *   · forceCompactForOverflow 漏了 summary 清理、粘性闭嘴降级、尾行 digest 过滤
 * 现在这些一律加载真实 TS 直接调真实函数（unit 级数学/分类）。
 *
 * 仍然保留的源码文本断言只剩两类，都是有意的：
 *   ① 数据表负面回归：已下线的模型 ID / 已被删的旁路函数不得回流（全文件扫描）
 *   ② 未导出、且不搭整条 flush 就无法观测的 wiring（触点保持接线）
 * 端到端的「触顶 → compact → 换厂商重试」在 verify-failure-recovery.mjs 里覆盖，这里不重复。
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// 打包产物必须落在仓库 node_modules 内：bundle 里的 external（extract-zip）
// 仍是裸导入，放系统临时目录会解析不到包
const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-nvidia-'));

async function loadModule(relTsPath) {
    const outfile = path.join(
        tmpDir,
        `${path.basename(relTsPath, '.ts')}-${Math.random().toString(36).slice(2, 7)}.mjs`,
    );
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

try {
    const nctx = await loadModule('src/auth/smart-chat-nvidia-context.ts');
    const compactMod = await loadModule('src/auth/smart-chat-compact.ts');
    const providerMod = await loadModule('src/auth/smart-chat-provider.ts');
    const cfgMod = await loadModule('src/auth/smart-chat-config.ts');
    const webLogic = await loadModule('webui-src/smartChatLogic.ts');

    const {
        estimateTextTokens,
        estimateMessagesTokens,
        nvidiaContextBudget,
        NVIDIA_CONTEXT_PRECHECK_RATIO,
    } = nctx;
    const {
        forceCompactForOverflow,
        isDigestMessage,
        buildDigestContent,
        assertCompactPolicyInvariants,
        OVERFLOW_KEEP_TAIL,
        COMPACT_KEEP_TAIL,
        COMPACT_MESSAGE_THRESHOLD,
        COMPACT_HYSTERESIS,
    } = compactMod;
    const { isContextOverflowError, isFatalUpstreamError, resolveChatCompletionTimeoutMs } = providerMod;
    const { SMART_CHAT_MODELS_NVIDIA, SMART_CHAT_VENDOR_PRESETS, normalizeSmartChatModel } = cfgMod;
    const { SC_VENDOR_PRESETS } = webLogic;

    // -------------------------------------------------------------------------
    // 1) token 估算（真实估算器）
    // -------------------------------------------------------------------------
    assert.strictEqual(estimateTextTokens(''), 0);
    // 口径已统一到 token-meter（字符分类 + 真实 usage 标定）：
    // 「你好世界hello」= 4 个 CJK×0.65 + 5 ASCII/4 → ceil(2.6+1.25)=4
    assert.strictEqual(estimateTextTokens('你好世界hello'), 4);
    assert.strictEqual(
        estimateMessagesTokens([{ role: 'user', content: 'a'.repeat(250) }]),
        67, // 4 开销 + ceil(250 / 4)
    );
    // tool_calls 也要计费：估算器真实现有这条分支，旧内联副本漏了（旧副本会答 4）
    assert.strictEqual(
        estimateMessagesTokens([{ role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }]),
        7, // 4 + 0 + ceil(len('[{"id":"x"}]')=12 / 4)
    );
    // 中文按 0.65 token/字（实测标定）：4 个字应略多于 2 token
    assert.strictEqual(estimateTextTokens('参数与结论'), 4);
    assert.ok(
        estimateTextTokens('中'.repeat(100)) > estimateTextTokens('a'.repeat(100)),
        '同样字符数下中文 token 更多（口径必须区分字符类别）',
    );
    assert.strictEqual(estimateMessagesTokens(null), 0);

    // -------------------------------------------------------------------------
    // 2) NIM 上下文预算表（真实 nvidiaContextBudget）
    // -------------------------------------------------------------------------
    assert.strictEqual(nvidiaContextBudget('deepseek-ai/deepseek-v4-flash-0731'), 800_000);
    assert.strictEqual(nvidiaContextBudget('nvidia/nemotron-3-ultra-550b-a55b'), 800_000);
    assert.strictEqual(nvidiaContextBudget('nvidia/nemotron-3-super-120b-a12b'), 800_000);
    assert.strictEqual(nvidiaContextBudget('moonshotai/kimi-k2.6'), 110_000);
    assert.strictEqual(nvidiaContextBudget('google/gemma-4-31b-it'), 110_000);
    assert.strictEqual(nvidiaContextBudget('google/diffusiongemma-26b-a4b-it'), 110_000);
    assert.strictEqual(nvidiaContextBudget('nvidia/nemotron-3.5-lightning-30b-a3b'), 110_000);
    assert.strictEqual(nvidiaContextBudget('nvidia/nemotron-3-nano-8b'), 110_000);
    assert.strictEqual(nvidiaContextBudget('meta/llama-3.3-70b-instruct'), 110_000);
    assert.strictEqual(nvidiaContextBudget('some/unknown-model'), 100_000, '未知模型走兜底档');
    assert.strictEqual(nvidiaContextBudget(''), 100_000);
    assert.strictEqual(nvidiaContextBudget('DeepSeek-AI/DeepSeek-V4-Flash-0731'), 800_000, '大小写不敏感');

    const backendModels = [...SMART_CHAT_MODELS_NVIDIA];
    const webModels = SC_VENDOR_PRESETS.nvidia.models.map((m) => m.value);
    // 预设里的每个可选模型都必须命中已知档位；落进 100_000 兜底 = 预算被低估，容易触顶
    for (const m of [...new Set([...backendModels, ...webModels])]) {
        assert.ok(
            [800_000, 110_000].includes(nvidiaContextBudget(m)),
            `预设模型 ${m} 落进兜底档（${nvidiaContextBudget(m)}），预算会被低估`,
        );
    }

    // 预检阈值数学：真实常量 + 真实估算器。比较式本身在 flush 内联（未导出），
    // 这里只钉住「常量 + 估算器」这半边的量级：240k 字系统提示必须顶穿 110k 档的 85%
    assert.strictEqual(NVIDIA_CONTEXT_PRECHECK_RATIO, 0.85);
    const budget110k = nvidiaContextBudget('moonshotai/kimi-k2.6');
    assert.ok(estimateMessagesTokens([{ role: 'system', content: '字'.repeat(240_000) }]) > budget110k * NVIDIA_CONTEXT_PRECHECK_RATIO);
    assert.ok(estimateMessagesTokens([{ role: 'user', content: '在吗' }]) < budget110k * NVIDIA_CONTEXT_PRECHECK_RATIO);

    // -------------------------------------------------------------------------
    // 3) 触顶错误分类（真实 isContextOverflowError / isFatalUpstreamError）
    // -------------------------------------------------------------------------
    const sample =
        'You passed 170753 input tokens and requested 32000 output tokens. However, the model\'s context length is only 202752 tokens, resulting in a maximum input length of 170752 tokens. Please reduce the length of the input prompt. (parameter=input_tokens)';
    assert.ok(isContextOverflowError(sample));
    assert.ok(isContextOverflowError('context_length_exceeded'));
    assert.ok(isContextOverflowError('reduce the length of the input prompt'));
    assert.ok(!isContextOverflowError('invalid api key'));
    assert.ok(!isContextOverflowError('rate limit 429'));
    // 触顶不算致命（provider:669-672 的守卫）：用同时命中两套正则的串才证明守卫真的在
    const ambiguous = 'context_length_exceeded: too many tokens, rate limit 429';
    assert.ok(isContextOverflowError(ambiguous));
    assert.strictEqual(isFatalUpstreamError(ambiguous), false, '触顶必须先被判为非致命，否则不会 compact 重试');
    assert.strictEqual(isFatalUpstreamError('fetch failed'), true);
    assert.strictEqual(isFatalUpstreamError('invalid api key'), true);
    assert.strictEqual(isFatalUpstreamError('rate limit 429'), true);

    // -------------------------------------------------------------------------
    // 4) digest 判定与生成（真实 isDigestMessage / buildDigestContent）
    // -------------------------------------------------------------------------
    assert.strictEqual(isDigestMessage({ role: 'user', content: '<compaction-summary>\nx\n</compaction-summary>' }), true);
    assert.strictEqual(isDigestMessage({ role: 'assistant', content: '<compaction-summary>\nx\n</compaction-summary>' }), false, 'digest 只认 user 行（旧内联副本漏了 role 判定）');
    assert.strictEqual(isDigestMessage({ role: 'user', content: '<compaction-summary>\n<host-state>x</host-state>\n</compaction-summary>' }), false, '误包普通回合的壳不算 digest');
    assert.strictEqual(isDigestMessage({ role: 'user', content: '今天好热' }), false);
    assert.strictEqual(isDigestMessage({ role: 'user', content: '说明：以下为远史压缩，近史原文在后面的消息里' }), true);
    assert.strictEqual(isDigestMessage(null), false);

    const digest = buildDigestContent([
        { role: 'user', content: '我叫阿伟，以后叫我阿伟就行' },
        { role: 'assistant', content: '<msg>我觉得还是别急着买</msg>' },
    ]);
    assert.ok(digest.includes('<compaction-summary>'));
    assert.ok(digest.includes('说明：以下为远史压缩'));
    assert.ok(digest.includes('我叫阿伟'), '远史 user 原文要点要进 digest');
    assert.ok(digest.includes('我觉得还是别急着买'), 'assistant 发言要进 digest');
    assert.ok(!digest.includes('<msg>'), 'digest 不能把 API 自标原样带进去');
    assert.strictEqual(isDigestMessage({ role: 'user', content: digest }), true, '真实生成的 digest 必须被真实判定认成 digest');

    // -------------------------------------------------------------------------
    // 5) 触顶强制 compact（真实 forceCompactForOverflow）
    // -------------------------------------------------------------------------
    assert.strictEqual(OVERFLOW_KEEP_TAIL, 24);
    assertCompactPolicyInvariants(); // KEEP+1+HYSTERESIS < THRESHOLD，真实现自己校验
    assert.ok(COMPACT_KEEP_TAIL + 1 + COMPACT_HYSTERESIS < COMPACT_MESSAGE_THRESHOLD);

    const makeLong = (n) => Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${i}-${'话'.repeat(20)}`,
    }));

    {
        const msgs = makeLong(60);
        const tailBefore = msgs.slice(-24).map((m) => m.content);
        const session = { messages: msgs, summary: '旧摘要', prefer_silence: true };
        const before = session.messages.length;
        assert.strictEqual(forceCompactForOverflow(session, { keepTail: 24 }), true);
        assert.ok(session.messages.length < before);
        assert.ok(isDigestMessage(session.messages[0]));
        assert.ok(session.compacted_at);
        assert.ok(session.messages.length >= 2);
        assert.strictEqual(session.messages.length, 25, '应为 1 条 digest + 24 条尾');
        assert.deepStrictEqual(session.messages.slice(1).map((m) => m.content), tailBefore, '尾部消息必须原样保留');
        assert.strictEqual(session.summary, undefined, '压完要删旧 summary（旧内联副本漏了）');
        assert.strictEqual(session.prefer_silence, false, '压后要降级粘性闭嘴');
    }

    {
        const session = { messages: makeLong(60) };
        assert.strictEqual(forceCompactForOverflow(session, { keepTail: 999 }), true);
        assert.strictEqual(session.messages.length, 25, 'keepTail 上限被 OVERFLOW_KEEP_TAIL 夹住');
    }

    {
        const session = { messages: makeLong(60) };
        assert.strictEqual(forceCompactForOverflow(session, { keepTail: 1 }), true);
        assert.strictEqual(session.messages.length, 5, 'keepTail 下限是 4');
    }

    {
        const session = { messages: makeLong(3) };
        const snapshot = JSON.stringify(session);
        assert.strictEqual(forceCompactForOverflow(session, { keepTail: 24 }), false, '太短的会话不该被压');
        assert.strictEqual(JSON.stringify(session), snapshot, '返回 false 时不得改动会话');
    }

    // -------------------------------------------------------------------------
    // 6) EOL 别名归一化（真实 normalizeSmartChatModel）
    // -------------------------------------------------------------------------
    const NVIDIA_DEFAULT = 'deepseek-ai/deepseek-v4-flash-0731';
    assert.strictEqual(normalizeSmartChatModel('deepseek-ai/deepseek-v4-flash', 'nvidia'), NVIDIA_DEFAULT);
    assert.strictEqual(normalizeSmartChatModel('deepseek-ai/deepseek-v4-pro', 'nvidia'), NVIDIA_DEFAULT);
    assert.strictEqual(normalizeSmartChatModel('z-ai/glm-5.2', 'nvidia'), NVIDIA_DEFAULT);
    assert.strictEqual(normalizeSmartChatModel('moonshotai/kimi-k2-instruct', 'nvidia'), 'moonshotai/kimi-k2.6');
    assert.strictEqual(normalizeSmartChatModel('DEEPSEEK-AI/DEEPSEEK-V4-PRO', 'nvidia'), NVIDIA_DEFAULT, '别名查表大小写不敏感');
    assert.strictEqual(normalizeSmartChatModel('MOONSHOTAI/KIMI-K2.6', 'nvidia'), 'moonshotai/kimi-k2.6', '预设查表大小写不敏感');
    assert.strictEqual(normalizeSmartChatModel('不存在的模型', 'nvidia'), NVIDIA_DEFAULT, '未知 ID 落回预设默认');
    assert.strictEqual(normalizeSmartChatModel('', 'nvidia'), NVIDIA_DEFAULT);
    assert.strictEqual(normalizeSmartChatModel('deepseek-v4-flash', 'deepseek'), 'deepseek-v4-flash');
    assert.strictEqual(normalizeSmartChatModel('deepseek-ai/deepseek-v4-flash', 'deepseek'), 'deepseek-v4-flash', 'EOL 别名只在英伟达生效');

    // 数据表：后台预设 == WebUI 预设，且已下线模型不得回流
    assert.deepStrictEqual([...SMART_CHAT_VENDOR_PRESETS.nvidia.models], backendModels);
    assert.deepStrictEqual(webModels, backendModels, '后台与 WebUI 的英伟达模型表必须一致（顺序也要一致）');
    assert.strictEqual(SMART_CHAT_VENDOR_PRESETS.nvidia.default_model, NVIDIA_DEFAULT);
    assert.strictEqual(SC_VENDOR_PRESETS.nvidia.default_model, NVIDIA_DEFAULT);
    for (const gone of [
        'deepseek-ai/deepseek-v4-flash',
        'deepseek-ai/deepseek-v4-pro',
        'minimaxai/minimax-m3',
        'mistralai/mistral-medium-3.5-128b',
        'z-ai/glm-5.2',
    ]) {
        assert.ok(!backendModels.includes(gone), `${gone} 不该再是可选项`);
        assert.ok(!webModels.includes(gone), `${gone} 不该再出现在 WebUI 模型表`);
    }

    // 超时：真实 resolveChatCompletionTimeoutMs
    assert.strictEqual(resolveChatCompletionTimeoutMs('nvidia'), 180_000);
    assert.strictEqual(resolveChatCompletionTimeoutMs('deepseek'), 90_000);

    // -------------------------------------------------------------------------
    // 7) 剩下只能做文本断言的（全文件负面回归 / 未导出触点）
    // -------------------------------------------------------------------------
    {
        const cfgSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-config.ts'), 'utf8');
        // 已下线的模型不得作为「可选项」回流（别名键是带冒号的写法，故按带尾逗号匹配）
        assert.ok(!cfgSrc.includes("'deepseek-ai/deepseek-v4-flash',"));
        assert.ok(!cfgSrc.includes("'deepseek-ai/deepseek-v4-pro',"));
        assert.ok(!cfgSrc.includes("'z-ai/glm-5.2',"));
        assert.ok(!cfgSrc.includes('minimaxai/minimax-m3'));
        assert.ok(!cfgSrc.includes('mistralai/mistral-medium-3.5-128b'));

        const logicSrc = fs.readFileSync(path.join(root, 'webui-src/smartChatLogic.ts'), 'utf8');
        assert.ok(!logicSrc.includes('minimax-m3'));
        assert.ok(!logicSrc.includes('z-ai/glm-5.2'));
        assert.ok(!/['"]deepseek-ai\/deepseek-v4-flash['"]/.test(logicSrc));

        const providerSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-provider.ts'), 'utf8');
        // 请求体里的关闭思考开关（内联在 body 构造里，未导出）
        assert.ok(providerSrc.includes("reasoning_effort = 'none'"));
        assert.ok(!providerSrc.includes('isNvidiaRequestAllowed'), 'no client-side 429 preflight gate');

        const rateSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-nvidia-rate.ts'), 'utf8');
        assert.ok(!rateSrc.includes('NVIDIA_DEFAULT_429_COOLDOWN_MS'), 'no built-in 429 cooldown');
        assert.ok(!rateSrc.includes('isNvidiaRequestAllowed'));

        const imageSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-image.ts'), 'utf8');
        assert.ok(imageSrc.includes('加载超时'), 'short vision failure body');

        const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
        // 触顶恢复触点：真跑这条路径需要整条 flush（见 verify-failure-recovery.mjs），这里只钉接线
        assert.ok(flushSrc.includes('applyOverflowCompact'), '触顶恢复函数仍在');
        assert.ok(flushSrc.includes('context_overflow_exhausted'));
        assert.ok(
            flushSrc.includes("from './smart-chat-nvidia-context'"),
            '预算预检必须用真实 nvidia-context 模块的估算器/预算表',
        );
        assert.ok(flushSrc.includes('nvidiaContextBudget(config.model)'), '预算预检仍在 flush 里用真实预算表');
        assert.ok(
            !/isNvidiaBuiltin\s*&&\s*!result\.ok\s*&&\s*isContextOverflowError/.test(flushSrc),
            '触顶重试不再只挂在英伟达分支（别的厂商也会遇到上下文超长）',
        );
        assert.ok(!flushSrc.includes('applyNvidiaOverflowCompact'), '旧名已并入 applyOverflowCompact');
    }
} finally {
    removeTmpDir(tmpDir);
}

console.log('verify-nvidia-overflow: all passed');
