/**
 * 语音输出（AI 配音）——纯逻辑 + 接线契约
 *   · 净化 / 合格判定 / 角色列表解析 / 密钥优先级（真实源码）
 *   · 配置归一化含 voice 且不进会话指纹
 *   · 分群 allow_voice 开关读写往返（内存 deps）
 *   · 出站/落盘/Web/前端接线断言（防回归）
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-voice-'));

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

const voice = await loadModule('src/auth/smart-chat-voice.ts');
const configMod = await loadModule('src/auth/smart-chat-config.ts');
const switchesMod = await loadModule('src/auth/smart-chat-switches.ts');
const fpMod = await loadModule('src/auth/smart-chat-fingerprint.ts');
const replyMod = await loadModule('src/auth/smart-chat-reply.ts');
const outboundMod = await loadModule('src/auth/smart-chat-outbound.ts');

const {
    sanitizeVoiceText,
    voiceReadyText,
    extractRoleNames,
    resolveVoiceKey,
    resolveVoiceEngine,
    isUsingOwnVoiceKey,
    voiceMaxChars,
    VOICE_HARD_CHAR_CAP,
    VOICE_MAX_SEGMENTS,
} = voice;

// —— 净化：去 @ / URL / emoji / markdown / 括号，保留中英数字与基础可念标点 ——
{
    const s = sanitizeVoiceText('你好@张三 看看 https://a.com [CQ:face,id=1] **加粗** 😀 (备注) 【标题】：好耶！');
    assert.ok(!s.includes('@'), '应去掉艾特');
    assert.ok(!/https?:/.test(s), '应去掉URL');
    assert.ok(!s.includes('CQ:'), '应去掉CQ码');
    assert.ok(!s.includes('*'), '应去掉markdown');
    assert.ok(!s.includes('😀'), '应去掉emoji');
    assert.ok(!s.includes('【') && !s.includes('(') && !s.includes('（'), '应去掉括号');
    assert.ok(s.includes('你好') && s.includes('好耶'), '中文正文保留');
    assert.ok(s.includes('！') || s.includes('!'), '基础可念标点保留');
}

// —— 合格判定 ——
{
    assert.strictEqual(voiceReadyText('', 150), null, '空文本不合格');
    assert.strictEqual(voiceReadyText('！！！……', 150), null, '纯标点不合格');
    assert.strictEqual(voiceReadyText('@某人 https://x.com', 150), null, '净化后空 → 不合格');
    const long = '哈'.repeat(151);
    assert.strictEqual(voiceReadyText(long, 150), null, '超长不合格');
    const ok = voiceReadyText('今天天气不错，一起去吃饭吧', 150);
    assert.ok(typeof ok === 'string' && ok.includes('吃饭'), '正常短句合格');
    // 边界：恰好等于上限
    assert.ok(voiceReadyText('字'.repeat(150), 150), '恰好150字合格');
    assert.strictEqual(voiceReadyText('字'.repeat(150), 149), null, '限长149时150字不合格');
}

// —— 硬顶常量 ——
assert.strictEqual(VOICE_HARD_CHAR_CAP, 150, '硬顶 150');
assert.strictEqual(VOICE_MAX_SEGMENTS, 2, '单次回复最多两条语音');

// —— 角色列表解析（防御式） ——
{
    assert.deepStrictEqual(extractRoleNames({ code: 200, data: ['甲', '乙', '甲'] }), ['甲', '乙'], '数组去重');
    assert.deepStrictEqual(extractRoleNames({ list: [{ name: '丙' }, { speaker: '丁' }] }), ['丙', '丁'], '对象取 name/speaker');
    assert.deepStrictEqual(extractRoleNames(['x', 'y']), ['x', 'y'], '裸数组');
    assert.deepStrictEqual(extractRoleNames({ code: 402 }), [], '无角色 → 空');
}

// —— 密钥优先级：自有覆盖内置；空回落内置；内置是新密钥不是旧的 ——
{
    const builtin = resolveVoiceKey({ voice: {} });
    assert.ok(builtin && typeof builtin === 'string', '内置密钥存在');
    assert.notStrictEqual(builtin, 'sk-3907fd0c7cf9411f476d97c80c9d2377', '不能再是旧密钥');
    assert.strictEqual(resolveVoiceKey({ voice: { api_key: 'MINE' } }), 'MINE', '自有优先');
    assert.strictEqual(isUsingOwnVoiceKey({ voice: { api_key: 'MINE' } }), true);
    assert.strictEqual(isUsingOwnVoiceKey({ voice: {} }), false);
}

// —— 引擎选择 ——
{
    assert.strictEqual(resolveVoiceEngine({ voice: {} }), 'pearapi', '缺省 pearapi');
    assert.strictEqual(resolveVoiceEngine({ voice: { engine: 'qqai' } }), 'qqai');
    assert.strictEqual(resolveVoiceEngine({ voice: { engine: '乱填' } }), 'pearapi', '非法引擎回落 pearapi');
}

// —— voiceMaxChars 夹取 ——
{
    assert.strictEqual(voiceMaxChars({ voice: { max_chars: 80 } }), 80);
    assert.strictEqual(voiceMaxChars({ voice: { max_chars: 999 } }), 150, '上限 150');
    assert.strictEqual(voiceMaxChars({ voice: {} }), 150, '缺省 150');
}

// —— 配置归一化：voice 子对象存在、格式/限长受控 ——
{
    const { normalizeSmartChatConfig, defaultVoiceSettings, DEFAULT_VOICE_DUB } = configMod;
    const d = defaultVoiceSettings();
    assert.strictEqual(d.engine, 'pearapi');
    assert.strictEqual(d.api_key, '');
    // 第三方配音默认角色：留空不再是「按文本发送」，而是走这个默认角色
    assert.strictEqual(d.dub, DEFAULT_VOICE_DUB);
    assert.strictEqual(d.dub, '病娇少女');
    assert.strictEqual(d.format, 'ogg');
    assert.strictEqual(d.qq_character, '');
    assert.strictEqual(d.qq_ref_group, '');
    assert.strictEqual(d.max_chars, 150);

    // 空 dub（含空串/空白/null/undefined/整个 voice 缺失）一律回落默认角色
    for (const raw of [{}, { dub: '' }, { dub: '   ' }, { dub: null }, { dub: undefined }]) {
        const c = normalizeSmartChatConfig({ model: 'x', voice: raw });
        assert.strictEqual(c.voice.dub, '病娇少女', `空 dub ${JSON.stringify(raw)} 应回落默认角色`);
    }

    const cfg = normalizeSmartChatConfig({ model: 'x', voice: { engine: 'qqai', dub: '文静学姐', format: 'wav', max_chars: 500, api_key: '  k  ', qq_character: 'voice-1', qq_ref_group: 'ab123c4' } });
    assert.ok(cfg.voice, '归一化后含 voice');
    assert.strictEqual(cfg.voice.engine, 'qqai');
    // 用户自选角色必须原样保留，默认值只兜底、不覆盖
    assert.strictEqual(cfg.voice.dub, '文静学姐');
    assert.strictEqual(cfg.voice.format, 'ogg', '非法格式回落 ogg');
    assert.strictEqual(cfg.voice.max_chars, 150, '超限夹到 150');
    assert.strictEqual(cfg.voice.api_key, 'k', '密钥 trim');
    assert.strictEqual(cfg.voice.qq_character, 'voice-1');
    assert.strictEqual(cfg.voice.qq_ref_group, '1234', '参考群号只留数字');

    const cfg2 = normalizeSmartChatConfig({ model: 'x', voice: { format: 'mp3', max_chars: 60 } });
    assert.strictEqual(cfg2.voice.format, 'mp3');
    assert.strictEqual(cfg2.voice.max_chars, 60);

    const cfgEmpty = normalizeSmartChatConfig({ model: 'x' });
    assert.ok(cfgEmpty.voice, '缺省也补齐 voice');
    assert.strictEqual(cfgEmpty.voice.format, 'ogg');
}

// —— voice 不进会话指纹（改角色/密钥不该切会话） ——
{
    const { normalizeSmartChatConfig } = configMod;
    const { sessionConfigFingerprint } = fpMod;
    const base = normalizeSmartChatConfig({ model: 'x', voice: { dub: 'A', api_key: 'k1' } });
    const changed = normalizeSmartChatConfig({ model: 'x', voice: { dub: 'B', api_key: 'k2', format: 'mp3' } });
    assert.strictEqual(
        sessionConfigFingerprint(base),
        sessionConfigFingerprint(changed),
        'voice 变化不得改变会话指纹',
    );
}

// —— 分群 allow_voice 开关读写往返（内存 deps） ——
{
    const {
        isSmartChatAllowVoiceGroup,
        setSmartChatAllowVoiceGroup,
        isSmartChatAllowVoiceFriend,
        setSmartChatAllowVoiceFriend,
        isSmartChatAllowVoiceForEvent,
    } = switchesMod;

    const store = {};
    const deps = {
        readB: (file, key, def) => (store[file] && key in store[file] ? store[file][key] : def),
        writeB: (file, key, val) => { (store[file] || (store[file] = {}))[key] = val; },
    };

    assert.strictEqual(isSmartChatAllowVoiceGroup(deps, '123'), false, '默认关闭');
    setSmartChatAllowVoiceGroup(deps, '123', true);
    assert.strictEqual(isSmartChatAllowVoiceGroup(deps, '123'), true, '开启后为真');
    setSmartChatAllowVoiceGroup(deps, '123', false);
    assert.strictEqual(isSmartChatAllowVoiceGroup(deps, '123'), false, '关闭后为假');

    assert.strictEqual(isSmartChatAllowVoiceFriend(deps, '999'), false);
    setSmartChatAllowVoiceFriend(deps, '999', true);
    assert.strictEqual(isSmartChatAllowVoiceFriend(deps, '999'), true);

    // ForEvent 路由
    setSmartChatAllowVoiceGroup(deps, '555', true);
    assert.strictEqual(isSmartChatAllowVoiceForEvent(deps, { message_type: 'group', group_id: '555' }), true);
    assert.strictEqual(isSmartChatAllowVoiceForEvent(deps, { message_type: 'private', user_id: '999' }), true);
    assert.strictEqual(isSmartChatAllowVoiceForEvent(deps, { message_type: 'group', group_id: '000' }), false);

    // 群/好友互不串档
    assert.strictEqual(isSmartChatAllowVoiceFriend(deps, '555'), false, '群键不污染好友');
}

// —— <voice> 解析：模型主动点名的语音气泡（P1 的核心） ——
{
    const { parseAssistantActions } = replyMod;
    const acts = parseAssistantActions('<replies><msg>普通打字</msg><voice>用语音说这句</voice></replies>', [], {});
    const msgs = acts.filter((a) => a.type === 'msg');
    assert.strictEqual(msgs.length, 2, '一条普通 + 一条语音');
    const plain = msgs.find((a) => !a.voiceWanted);
    const spoken = msgs.find((a) => a.voiceWanted);
    assert.ok(plain && plain.text.includes('普通打字'), '普通气泡不带 voiceWanted');
    assert.ok(spoken && spoken.text.includes('用语音说这句'), '语音气泡带 voiceWanted');
    // 只有 <voice> 也算「开口」，不能被判成沉默
    const onlyVoice = parseAssistantActions('<voice>就说这一句</voice>', [], {});
    assert.ok(onlyVoice.some((a) => a.type === 'msg' && a.voiceWanted), '仅 voice 也是开口');
    assert.ok(!onlyVoice.some((a) => a.type === 'shut_up'), '仅 voice 不是沉默');
    // 语音气泡是单节点：不解析 at/reply
    const noAt = parseAssistantActions('<voice>喂喂</voice>', [], {});
    const v = noAt.find((a) => a.voiceWanted);
    assert.ok(v && (!v.at || v.at.length === 0) && !v.replyId, '语音气泡不带 at/reply');
}

// —— 历史序列化：voiceWanted 气泡写回 <voice> ——
{
    const { actionsToAssistantStoreContent } = outboundMod;
    const store = actionsToAssistantStoreContent(
        [{ type: 'msg', text: '打字句' }, { type: 'msg', text: '语音句', voiceWanted: true }],
        false,
    );
    assert.ok(store.includes('<msg>打字句</msg>'), '普通句用 <msg>');
    assert.ok(store.includes('<voice>语音句</voice>'), '语音句用 <voice> 记号');
}

// —— 接线契约（防回归） ——
{
    const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

    // bot 段构造器：新增 record 段
    const bot = src('src/lib/bot.ts');
    assert.ok(bot.includes('段_语音'), 'bot.ts 有 段_语音');
    assert.ok(bot.includes("type: 'record'") || bot.includes("type:'record'"), 'record 段类型');

    // deps 注入
    const core = src('src/mkai-core.ts');
    assert.ok(core.includes('段_语音'), 'mkai-core 注入 段_语音');

    // 出站：record 单节点分支 + 失败回退文本
    const outbound = src('src/auth/smart-chat-outbound.ts');
    assert.ok(outbound.includes('voiceFile'), '出站认 voiceFile');
    assert.ok(outbound.includes('段_语音'), '出站发语音段');
    assert.ok(/回退文本/.test(outbound), '出站有文本回退');

    // flush：只转模型点名的 voiceWanted 气泡 + 两条上限 + 开关门 + 引擎路由 + 传群号
    const flush = src('src/auth/smart-chat-flush.ts');
    assert.ok(flush.includes('isSmartChatAllowVoiceForEvent'), 'flush 读语音开关');
    assert.ok(flush.includes('synthesizeVoice'), 'flush 调用合成');
    assert.ok(flush.includes('VOICE_MAX_SEGMENTS'), 'flush 用两条上限');
    assert.ok(flush.includes('a.voiceWanted'), 'flush 只转模型点名的 <voice> 气泡（不是句句转）');
    assert.ok(flush.includes('resolveVoiceEngine'), 'flush 走引擎路由');
    assert.ok(/groupId:\s*voiceGroupId/.test(flush) || flush.includes('voiceGroupId'), 'flush 给 QQAI 传群号');
    assert.ok(flush.includes('qq_character') && flush.includes('config.voice?.dub'), 'flush 按引擎判是否配好角色');

    // voice 模块：请求头 + 本地下载 + QQAI 引擎
    const vsrc = src('src/auth/smart-chat-voice.ts');
    assert.ok(vsrc.includes('VOICE_HTTP_HEADERS') && /User-Agent/.test(vsrc), '合成/下载带请求头');
    assert.ok(vsrc.includes('downloadAudioToCache'), '先下载到本地再传');
    assert.ok(vsrc.includes('get_ai_record') && vsrc.includes('get_ai_characters'), 'QQAI 用 NapCat AI 语音动作');
    assert.ok(vsrc.includes('synthesizeViaQQ') && vsrc.includes('synthesizeViaPearapi'), '两套引擎实现');
    assert.ok(vsrc.includes('qqai_group_only'), 'QQAI 私聊回退文本');

    // 协议里教了 <voice>（静态挂载，不按群改写，避免前缀缓存抖动）
    const know = src('src/auth/smart-chat-knowledge.ts');
    assert.ok(know.includes('<voice>') && /发语音/.test(know), '协议教了 <voice> 能力');

    // Web：开关同步 + 三个端点（roles/characters/config）
    const web = src('src/auth/smart-chat-web.ts');
    assert.ok(web.includes('allow_voice'), 'web 开关字段 allow_voice');
    assert.ok(web.includes('setSmartChatAllowVoiceGroup'), 'web 写群语音开关');
    assert.ok(web.includes("wrapPath('/smart-chat/voice-roles')"), 'web 第三方角色端点');
    assert.ok(web.includes("wrapPath('/smart-chat/voice-characters')"), 'web QQAI 角色端点');
    assert.ok(web.includes("wrapPath('/smart-chat/voice-config')"), 'web 语音配置端点');
    assert.ok(web.includes('fetchQQVoiceCharacters'), 'web 代理 get_ai_characters');

    // configForWeb 不下发内置/明文密钥（只回掩码 + api_key_set），含 engine/qq_character
    const cfg = src('src/auth/smart-chat-config.ts');
    assert.ok(cfg.includes('voice_web'), 'configForWeb 组装掩码 voice');
    assert.ok(cfg.includes('api_key_set'), 'voice 掩码含 api_key_set');
    assert.ok(/engine:\s*voice\.engine/.test(cfg) && cfg.includes('qq_character'), 'voice_web 回传 engine/qq_character');

    // 前端接线
    assert.ok(src('webui-src/api.ts').includes("'voice'"), 'ViewId 含 voice');
    assert.ok(src('webui-src/shell/nav.ts').includes("id: 'voice'"), '侧栏含语音页');
    assert.ok(src('webui-src/shell/MobileShell.tsx').includes("id: 'voice'"), '手机更多含语音页');
    assert.ok(src('webui-src/App.tsx').includes('VoicePage'), 'App 路由到 VoicePage');
    const page = src('webui-src/pages/VoicePage.tsx');
    assert.ok(page.includes('/smart-chat/voice-roles'), '语音页拉第三方角色');
    assert.ok(page.includes('/smart-chat/voice-characters'), '语音页拉 QQAI 角色');
    assert.ok(page.includes('/smart-chat/voice-config'), '语音页存配置');
    // 引擎选择器：由 <select> 改为胶囊分段控件（左右两个胶囊，文案为 第三方配音 / QQAI配音）
    // 对应「切换引擎后下方只显示该引擎需要的设置」——分支渲染由 verify-voice-display 锁死
    assert.ok(page.includes('语音引擎'), '语音页有引擎选择器');
    assert.ok(/第三方配音/.test(page) && /QQAI配音/.test(page), '引擎胶囊文案为 第三方配音 / QQAI配音');
    assert.ok(/mk-seg__btn/.test(page), '引擎选择器为胶囊式控件');
    assert.ok(!/<option value="qqai"/.test(page), '引擎选择器不应回退成 <select>');
    const swPage = src('webui-src/pages/SwitchPage.tsx');
    assert.ok(swPage.includes('allow_voice'), '开关弹窗含语音开关');
    assert.ok(swPage.includes('允许以语音形式输出'), '开关弹窗文案');
}

// —— 内置密钥的「泄露面」守卫 ——
//
// 为什么写成从源码里读密钥、而不是把密钥字面量抄进断言：
// 断言里抄一份 = 仓库里多一个明文泄露点（而且换密钥时这份会过期变噪音）。
// 这里改成「动态取当前内置密钥 → 扫全仓」，既不会抄错，换密钥也自动跟着走。
{
    const readSrc = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    const voiceSrc = readSrc('src/auth/smart-chat-voice.ts');
    const m = voiceSrc.match(/const BUILT_IN_VOICE_KEY = '([^']+)'/);
    assert.ok(m, 'smart-chat-voice.ts 里应有 BUILT_IN_VOICE_KEY 常量');
    const builtinKey = m[1];
    assert.ok(builtinKey.length >= 8, `内置密钥看起来不像密钥：长度 ${builtinKey.length}`);

    // 1) 绝不允许出现在任何前端可达文件（会被打进 remote.js，等于公开）
    const frontendRoots = ['webui-src'];
    const walk = (dir) => {
        const out = [];
        for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const rel = `${dir}/${e.name}`;
            if (e.isDirectory()) out.push(...walk(rel));
            else out.push(rel);
        }
        return out;
    };
    for (const f of frontendRoots.flatMap(walk)) {
        assert.ok(!readSrc(f).includes(builtinKey), `前端文件泄露了内置密钥：${f}`);
    }

    // 2) 配置模板 / 前端契约 / README 里也不该出现
    for (const f of ['src/auth/smart-chat-config.ts', 'README.md', 'plugin.json', 'package.json']) {
        if (!fs.existsSync(path.join(root, f))) continue;
        assert.ok(!readSrc(f).includes(builtinKey), `${f} 泄露了内置密钥`);
    }

    // 3) scripts/ 下的调试脚本不该抄一份明文（要用手测就设 PEARAPI_KEY 环境变量）
    for (const f of walk('scripts')) {
        if (f.endsWith('verify-voice.mjs')) continue; // 本文件用动态读取，不抄明文
        assert.ok(!readSrc(f).includes(builtinKey), `${f} 抄了内置密钥明文（改用 PEARAPI_KEY 环境变量）`);
    }

    // 4) 正向确认：真身在宿主端源码里（这是设计允许的唯一落点）
    assert.ok(voiceSrc.includes(builtinKey), '内置密钥应在 smart-chat-voice.ts 中定义');
}

