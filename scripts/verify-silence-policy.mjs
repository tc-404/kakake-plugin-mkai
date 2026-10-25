/**
 * 2.2 沉默策略校准验收（加载真实 smart-chat-silence.ts，不用镜像实现）
 *
 * 覆盖：
 *   looksLikeOpenQuestion 判据保持宽松（问号也算），收紧全部放在 decideSilence 的上下文门槛
 *   开口激励门槛提到 streak >= limit - 1，且非 peerLoop、本批没有别人已在接话、无会话闭嘴偏好
 *   talk-graph 结论「没人在对你说话」→ soft（可旁听），不产生 skipLlm；问别人的问句同样走这支
 *   1.3.2 否决权：ratio 命中 → hard + skipLlm（宿主侧闭嘴，不发请求）；种子同轮可复现
 *   否决保底：@ / 要表情 / 工具已执行 / 沉默达上限 / 有人对你说话 / 关系图没结论 一律不否决
 *   单条批次也算 talk-graph 结论（computed 而非 text 判空）
 *   peerLoop hard 只在闭嘴不久时允许 skipLlm，久未开口自动解除
 *   达限必须开口仍然优先于一切 bias
 *
 * 运行：npm run verify:silence-policy
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
const cleanup = () => removeTmpDir(tmpDir);

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

const LIMIT = 5;
const base = (over = {}) => ({
    scene: { atBot: false, silenceBias: 'none', hostLines: [], peerLoop: false, openFloor: true },
    session: { shut_up_streak: 0 },
    silenceAllowedByConfig: true,
    atBot: false,
    batchText: '这个怎么弄啊',
    shutUpLimit: LIMIT,
    ...over,
});
const hasHint = (d, re) => (d.hostSilenceHints || []).some((h) => re.test(h));

try {
    const silence = await loadModule('src/auth/smart-chat-silence.ts');
    const { looksLikeOpenQuestion, decideSilence } = silence;

    // ------------------------------------------------------------ 开放问句判据（宽松，不做收紧）
    assert.strictEqual(looksLikeOpenQuestion('真的假的？'), true, '判据本身不收紧：有问号就算，收紧放在 decideSilence 的门槛');
    assert.strictEqual(looksLikeOpenQuestion('这个怎么弄啊'), true, '疑问词仍然算');
    assert.strictEqual(looksLikeOpenQuestion('有没有人会这个'), true, '求问句式仍然算');
    assert.strictEqual(looksLikeOpenQuestion('为什么会这样'), true, '为什么开头仍然算');
    assert.strictEqual(looksLikeOpenQuestion('哈哈哈草'), false, '纯闲聊不算问句');
    assert.strictEqual(looksLikeOpenQuestion('嗯'), false, '单字不算');
    assert.strictEqual(looksLikeOpenQuestion('[眼睛 msgid:1] 图里是啥'), false, '识图备注不算发言');
    assert.strictEqual(looksLikeOpenQuestion('补充：图片第1张解析结果 是啥'), false, '识图补充不算发言');

    // ------------------------------------------------------------ 开口激励门槛
    const nudged = decideSilence(base({ session: { shut_up_streak: LIMIT - 1 } }));
    assert.ok(hasHint(nudged, /激励: /), `streak=limit-1 应给开口激励，实测 ${JSON.stringify(nudged.hostSilenceHints)}`);

    const tooEarly = decideSilence(base({ session: { shut_up_streak: Math.floor(LIMIT / 2) } }));
    assert.ok(!hasHint(tooEarly, /激励: /), '半限就激励是 16 代把沉默率压到 12% 的原因，不该再触发');

    const chatterOnly = decideSilence(base({ session: { shut_up_streak: LIMIT - 1 }, batchText: '哈哈哈草' }));
    assert.ok(!hasHint(chatterOnly, /激励: /), '本批没有问句时不该激励开口');

    // 两人互指且有开放地板：不抬 hard，但也不激励插话
    const inPeerLoop = decideSilence(base({
        session: { shut_up_streak: LIMIT - 1 },
        scene: { atBot: false, silenceBias: 'none', hostLines: [], peerLoop: true, openFloor: true },
    }));
    assert.ok(!hasHint(inPeerLoop, /激励: /), 'peerLoop 期间不该激励开口');

    // 会话闭嘴偏好仍在 TTL 内：压过激励
    const preferring = decideSilence(base({
        session: { shut_up_streak: LIMIT - 1, prefer_silence: true, prefer_silence_at: new Date().toISOString() },
    }));
    assert.ok(!hasHint(preferring, /激励: /), '会话闭嘴偏好期间不该激励开口');
    assert.ok(hasHint(preferring, /会话偏好/), '闭嘴偏好应写入 host-state 且注明会过期');
    assert.strictEqual(preferring.sceneBias, 'soft', '闭嘴偏好只压到 soft，不 hard');

    // 别人已经在接话（talk-graph 有线程）→ 不抢答
    const peersBusy = decideSilence(base({ session: { shut_up_streak: LIMIT - 1 }, peerThreads: 1, addressedToBot: false, vetoRatio: 0 }));
    assert.ok(!hasHint(peersBusy, /激励: /), '本批已有他人在回答时不该激励开口');

    // ------------------------------------------------------------ talk-graph 结论接入
    // 16 代 [03]：寒愁洛的「你买了吗」是问潇的，宿主却当成在问自己
    // vetoRatio=0 = 1.3.1 的软提示口径（只降 soft，不否决）
    const nobody = decideSilence(base({ batchText: '你买了吗', addressedToBot: false, peerThreads: 1, vetoRatio: 0 }));
    assert.strictEqual(nobody.sceneBias, 'soft', '否决关掉时：关系图判定没人对你说话 → soft');
    assert.strictEqual(nobody.skipLlm, false, 'soft 不得预判跳过 LLM');
    assert.strictEqual(nobody.mustSpeak, false, '问别人的问句不构成必须开口');
    assert.strictEqual(nobody.addressVetoed, false, 'vetoRatio=0 不该否决');
    assert.ok(hasHint(nobody, /场况: 旁听（无指向本账号）/), '应写入 host-state 事实行');
    assert.ok(hasHint(nobody, /接不接都行/), '不否决时提示保持「接不接都行」');

    const someone = decideSilence(base({ addressedToBot: true, peerThreads: 1 }));
    assert.ok(!hasHint(someone, /场况: 旁听（无指向本账号）/), '有人对你说话时不该写反向提示');

    const noSignal = decideSilence(base({ addressedToBot: null }));
    assert.ok(!hasHint(noSignal, /场况: 旁听（无指向本账号）/), '关系图没算（单条批次）时不作判据');
    assert.strictEqual(noSignal.sceneBias, 'none', '没有关系图信号时不改 bias');

    // ------------------------------------------------------------ peerLoop hard 与自动解除
    const hardEarly = decideSilence(base({
        scene: { atBot: false, silenceBias: 'hard', hostLines: [], peerLoop: true, openFloor: false },
        addressedToBot: false,
        peerThreads: 2,
    }));
    assert.strictEqual(hardEarly.sceneBias, 'hard', '刚开始闭嘴时两人互指可维持 hard');
    assert.strictEqual(hardEarly.skipLlm, true, 'hard 允许预判跳过 LLM');

    const hardReleased = decideSilence(base({
        session: { shut_up_streak: LIMIT - 2 },
        scene: { atBot: false, silenceBias: 'hard', hostLines: [], peerLoop: true, openFloor: false },
    }));
    assert.strictEqual(hardReleased.sceneBias, 'none', '久未开口时 peerLoop 的 hard 自动解除');
    assert.strictEqual(hardReleased.skipLlm, false, '解除后不得再预判跳过 LLM');

    // ------------------------------------------------------------ 达限优先
    const capped = decideSilence(base({ session: { shut_up_streak: LIMIT }, addressedToBot: false, peerThreads: 2 }));
    assert.strictEqual(capped.forceSpeak, true, '达限必须开口');
    assert.strictEqual(capped.sceneBias, 'none', '达限时清掉 soft/hard');
    assert.ok(hasHint(capped, /沉默: 达上限/), '达限应有明确提示');

    // @ 到自己：mustSpeak 不受关系图影响
    const atBot = decideSilence(base({ atBot: true, addressedToBot: false, peerThreads: 3 }));
    assert.strictEqual(atBot.mustSpeak, true, '被艾特仍必须开口');
    assert.strictEqual(atBot.silenceAllowed, false, '被艾特时不允许沉默');

    // ------------------------------------------------------ 「没人对你说话」的否决权（1.3.2）
    const { buildSilenceVetoSeed, resolveSilenceVetoRatio, DEFAULT_SILENCE_VETO_RATIO } = silence;

    assert.strictEqual(resolveSilenceVetoRatio(undefined), DEFAULT_SILENCE_VETO_RATIO, '缺配置回落默认');
    assert.strictEqual(resolveSilenceVetoRatio('abc'), DEFAULT_SILENCE_VETO_RATIO, '非数字回落默认');
    assert.strictEqual(resolveSilenceVetoRatio(-1), 0, '负数收到 0');
    assert.strictEqual(resolveSilenceVetoRatio(2), 1, '超 1 收到 1');
    assert.strictEqual(resolveSilenceVetoRatio(0), 0, '显式 0 = 关掉否决，不能被当成缺值回落默认');

    // 种子：同一轮可复现（compose 与 flush 预判必须抽到同一个值），换一批消息就换值
    const seedA = buildSilenceVetoSeed('g_1', 2, ['101', '102']);
    assert.strictEqual(seedA, buildSilenceVetoSeed('g_1', 2, ['101', '102']), '同一轮必须是同一个种子');
    assert.notStrictEqual(seedA, buildSilenceVetoSeed('g_1', 2, ['101', '103']), '换消息应换种子');
    assert.notStrictEqual(seedA, buildSilenceVetoSeed('g_2', 2, ['101', '102']), '换群应换种子');
    assert.notStrictEqual(seedA, buildSilenceVetoSeed('g_1', 3, ['101', '102']), '沉默计数变化应换种子');

    const vetoBase = (over = {}) => base({
        batchText: '你买了吗',
        addressedToBot: false,
        peerThreads: 1,
        vetoSeed: seedA,
        ...over,
    });

    const vetoed = decideSilence(vetoBase({ vetoRatio: 1 }));
    assert.strictEqual(vetoed.addressVetoed, true, 'ratio=1 且没人对你说话 → 否决');
    assert.strictEqual(vetoed.sceneBias, 'hard', '否决落在 hard 上');
    assert.strictEqual(
        vetoed.skipLlm, true,
        '否决必须真的省掉这次请求；只写提示不跳过 = 还是 1.3.1 的软提示',
    );
    assert.ok(hasHint(vetoed, /本轮不开口/), '否决时 host-state 应写明不开口');

    const stable1 = decideSilence(vetoBase({ vetoRatio: 0.5 }));
    const stable2 = decideSilence(vetoBase({ vetoRatio: 0.5 }));
    assert.strictEqual(
        stable1.addressVetoed, stable2.addressVetoed,
        '同种子同比例必须抽到同一结果，否则 host-state 与预判会说两套',
    );

    // 保底：这些情形一律不许否决（ratio 拉满也不行）
    for (const [label, input] of [
        ['被艾特', vetoBase({ atBot: true, vetoRatio: 1 })],
        ['点名要表情', vetoBase({ requestedStickerCount: 2, vetoRatio: 1 })],
        ['工具已执行', vetoBase({ nonStickerToolsUsed: true, vetoRatio: 1 })],
        ['沉默达上限', vetoBase({ session: { shut_up_streak: LIMIT }, vetoRatio: 1 })],
        ['有人对你说话', vetoBase({ addressedToBot: true, vetoRatio: 1 })],
        ['关系图没算出结论', vetoBase({ addressedToBot: null, vetoRatio: 1 })],
        ['配置不允许沉默', vetoBase({ silenceAllowedByConfig: false, vetoRatio: 1 })],
    ]) {
        const d = decideSilence(input);
        assert.strictEqual(d.addressVetoed, false, `${label} 时不许否决`);
        assert.strictEqual(d.skipLlm, false, `${label} 时不许跳过 LLM`);
    }

    // 开口激励优先于否决：接近上限 + 场上有开放问句 + 没别人在接话 → 放它说一句（否决不会把它憋死）
    const nudgedOverVeto = decideSilence(vetoBase({
        session: { shut_up_streak: LIMIT - 1 },
        batchText: '这个怎么弄啊',
        peerThreads: 0,
        vetoRatio: 1,
    }));
    assert.ok(hasHint(nudgedOverVeto, /激励: /), '接近上限的开口激励应压过否决');
    assert.strictEqual(nudgedOverVeto.addressVetoed, false, '激励轮不否决');
    assert.strictEqual(nudgedOverVeto.skipLlm, false, '激励轮必须真的发请求');

    // 别人已经在接话时不给激励：这一轮该让否决生效（16 代抢答就出在这里）
    const peersBusyVeto = decideSilence(vetoBase({
        session: { shut_up_streak: LIMIT - 1 },
        batchText: '这个怎么弄啊',
        peerThreads: 1,
        vetoRatio: 1,
    }));
    assert.strictEqual(peersBusyVeto.addressVetoed, true, '有人已在接话 + 没人问你 → 否决');

    // -------------------------------- 单条批次也要给结论（否则最该闭嘴的场合正好漏掉）
    const compose = await loadModule('src/auth/smart-chat-compose.ts');
    const one = compose.buildTalkGraph(
        [{ userId: '1001', nickname: '群友1', text: '有没有好用的表情包图源', atQqs: [], messageId: '301' }],
        '2071521294',
        '汐音',
    );
    assert.strictEqual(one.text, '', '单条批次不渲染关系图（那段只会是空话）');
    assert.strictEqual(one.computed, true, '但结论要算出来：1.3.1 用 text 判空，等于把单条批次当没信号');
    assert.strictEqual(one.toBot.length, 0, '没人点你 → toBot 为空');
    const noSelf = compose.buildTalkGraph([{ userId: '1001', text: '随便说说', atQqs: [] }], '', '汐音');
    assert.strictEqual(noSelf.computed, false, '拿不到 self_id 时算不出对谁说话，不能给结论');

    // ------------------------------------------------------------ 配置项与指纹
    const cfgMod = await loadModule('src/auth/smart-chat-config.ts');
    assert.strictEqual(
        cfgMod.defaultSmartChatConfig().silence_veto_ratio, DEFAULT_SILENCE_VETO_RATIO,
        '默认配置的否决概率应与 silence.ts 的默认值一致',
    );
    assert.strictEqual(cfgMod.normalizeSmartChatConfig({}).silence_veto_ratio, DEFAULT_SILENCE_VETO_RATIO);
    assert.strictEqual(cfgMod.normalizeSmartChatConfig({ silence_veto_ratio: 0 }).silence_veto_ratio, 0, '显式 0 应保留');
    assert.strictEqual(cfgMod.normalizeSmartChatConfig({ silence_veto_ratio: 5 }).silence_veto_ratio, 1, '超界收到 1');
    assert.strictEqual(cfgMod.normalizeSmartChatConfig({ silence_veto_ratio: -3 }).silence_veto_ratio, 0, '负数收到 0');

    const fpSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-fingerprint.ts'), 'utf8');
    assert.ok(
        !/silence_veto_ratio/.test(fpSrc),
        '否决概率不得进会话指纹（调沉默力度不该切会话/丢记忆）',
    );

    // ------------------------------------------------------------ 源码约束
    const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
    assert.ok(/buildSilenceVetoSeed\(/.test(flushSrc), 'flush 必须自己算一次种子（与 compose 同源）');
    assert.strictEqual(
        (flushSrc.match(/^\s+vetoSeed,$/gm) || []).length, 2,
        'flush 两处 decideSilence 都要传同一个种子（各 1 处，共 2 处）',
    );
    const composeSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compose.ts'), 'utf8');
    assert.ok(
        /graphUsable = Boolean\(graph\?\.computed\)/.test(composeSrc),
        '结论可用性看 computed，不看 text 是否渲染',
    );
    assert.ok(
        !/graphUsable = Boolean\(graph\?\.text\)/.test(composeSrc),
        '不得回退到用 text 判断结论可用性',
    );

    console.log('verify-silence-policy: 全部通过');
} catch (e) {
    cleanup();
    throw e;
}

cleanup();