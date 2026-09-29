/**
 * 语音显示契约 —— 真跑源码 + 源码文本断言
 *
 * 背景：语音有两个方向，以前只有出站做了记号、入站被整段丢弃：
 *
 *   1) 入站（用户发的语音）：宿主 eventUserTextFromSegments() 原来只提 text 段，
 *      record 段被静默丢掉 → 群里有人发语音时，后台「会话」里那条消息**完全不可见**，
 *      模型也无从得知对方发了语音。现在统一记成 `[语音]`（有转写就 `[语音]正文`）。
 *
 *   2) 出站（机器人发的语音）：历史里存的是 <voice>正文</voice>，
 *      但 WebUI 的 parseAssistantChunk 只认 <msg>/<sticker>/<react>，
 *      <voice> 被漏掉 → 后台看不到机器人发过语音。现在渲染成「[语音]正文」。
 *
 * 注意记号不能混用：<voice> 专指「机器人自己用语音说的」，入站一律用 [语音]，
 * 否则模型会把自己的语音和用户的语音搞混（这也是本脚本锁的一条契约）。
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-voice-display-'));

async function loadTs(relTsPath, name) {
    const outfile = path.join(tmpDir, `${name}.mjs`);
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

const bot = await loadTs('src/lib/bot.ts', 'bot');

// —— 1. 入站语音段：不再被丢掉，记成 [语音] ——
{
    const ev = {
        message: [
            { type: 'text', data: { text: '早上好' } },
            { type: 'record', data: { file: 'abc.silk' } },
        ],
    };
    const text = bot.eventUserTextFromSegments(ev);
    assert.ok(text.includes('早上好'), '纯文本段照旧提取');
    assert.ok(text.includes('[语音]'), `入站语音段必须留下占位，实得 ${JSON.stringify(text)}`);
    assert.ok(!/<voice>/i.test(text), '入站不得用 <voice>（那是出站记号，会跟"机器人自己发的"混淆）');
}

// —— 2. 入站语音带 NapCat 转写文本：拼成 [语音]正文 ——
{
    const ev = { message: [{ type: 'record', data: { file: 'a.silk', text: '今天天气不错' } }] };
    assert.strictEqual(
        bot.eventUserTextFromSegments(ev),
        '[语音]今天天气不错',
        '有转写文本时接在占位后面',
    );
}

// —— 3. 纯语音（无文本、无转写）：仍然非空，不会整条消息被丢弃 ——
{
    const ev = { message: [{ type: 'record', data: { file: 'only.silk' } }] };
    assert.strictEqual(bot.eventUserTextFromSegments(ev), '[语音]');
    // smartChatIngest 靠 trim 后非空来决定是否入队；这里必须非空
    assert.ok(bot.eventUserTextFromSegments(ev).trim().length > 0, '纯语音必须能入队');
}

// —— 4. text 与 record 的先后顺序保持原样 ——
{
    const ev = {
        message: [
            { type: 'record', data: { file: 'a.silk' } },
            { type: 'text', data: { text: '后面这句' } },
        ],
    };
    assert.strictEqual(bot.eventUserTextFromSegments(ev), '[语音]后面这句', '段顺序不得打乱');
}

// —— 5. 老路径不回归：字符串消息 / raw_message 仍原样返回 ——
{
    assert.strictEqual(bot.eventUserTextFromSegments({ message: '纯字符串' }), '纯字符串');
    assert.strictEqual(bot.eventUserTextFromSegments({ raw_message: '裸文本' }), '裸文本');
    assert.strictEqual(bot.eventUserTextFromSegments({ message: '[CQ:record,file=a.silk]' }), '', 'CQ 串仍不解析为文本');
    assert.strictEqual(bot.eventUserTextFromSegments({}), '', '空事件返回空串');
    assert.strictEqual(bot.eventUserTextFromSegments(null), '', 'null 不炸');
}

// —— 6. 出站 <voice> 渲染为 [语音]正文（真跑 WebUI 解析层） ——
{
    const tx = await loadTs('webui-src/sessionTranscript.ts', 'sessionTranscript');
    const session = {
        bot_card: '小助手',
        messages: [
            { role: 'assistant', content: '<replies>\n<msg>打字说的</msg>\n<voice>用语音说的</voice>\n</replies>' },
        ],
    };
    const bubbles = tx.sessionToBubbles(session);
    const voice = bubbles.find((b) => b.kind === 'voice');
    assert.ok(voice, `<voice> 段必须有气泡，实得 ${JSON.stringify(bubbles.map((b) => b.kind))}`);
    assert.strictEqual(voice.side, 'out', '语音气泡在机器人一侧');
    assert.strictEqual(voice.text, '[语音]用语音说的', '按 [语音]正文 显示');
    assert.ok(bubbles.some((b) => b.text === '打字说的'), '普通文字气泡不受影响');
    // 不得把原始标签漏进正文
    assert.ok(!bubbles.some((b) => /<\/?voice>/i.test(b.text)), '正文不得残留 <voice> 标签');
}

// —— 7. 空 <voice></voice> 也有气泡（否则发过语音却看不见） ——
{
    const tx = await loadTs('webui-src/sessionTranscript.ts', 'sessionTranscript2');
    const bubbles = tx.sessionToBubbles({
        bot_card: '小助手',
        messages: [{ role: 'assistant', content: '<replies>\n<voice></voice>\n</replies>' }],
    });
    const voice = bubbles.find((b) => b.kind === 'voice');
    assert.ok(voice, '空语音段也要有气泡');
    assert.strictEqual(voice.text, '[语音]', '空语音显示为纯占位');
}

// —— 8. 入站 [语音] 占位原样透传到后台气泡 ——
{
    const tx = await loadTs('webui-src/sessionTranscript.ts', 'sessionTranscript3');
    const bubbles = tx.sessionToBubbles({
        bot_card: '小助手',
        messages: [
            {
                role: 'user',
                content: '[2026-09-29 12:00:00] 张三(10001) [成员]: [语音]今天天气不错\n',
            },
        ],
    });
    const said = bubbles.find((b) => b.side === 'in');
    assert.ok(said, '入站语音必须能解析出气泡');
    assert.strictEqual(said.text, '[语音]今天天气不错', '入站占位不得被清洗逻辑吃掉');
}

// —— 9. 源码级：出入两向的记号不得互相污染 ——
{
    const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

    // 入站侧只能用 [语音] 占位
    const botSrc = src('src/lib/bot.ts');
    assert.ok(/段_入站语音占位/.test(botSrc), 'bot.ts 应导出段_入站语音占位');
    const placeholders = botSrc.match(/return t \? `\[语音\]/g) || [];
    assert.ok(placeholders.length >= 1, '入站占位文案应为 [语音]开头');

    // 出站侧仍以 voiceWanted → <voice> 落历史
    const outSrc = src('src/auth/smart-chat-outbound.ts');
    assert.ok(
        /if \(a\.voiceWanted\) return `<voice>\$\{a\.text \|\| ''\}<\/voice>`/.test(outSrc),
        '出站历史仍写 <voice>（WebUI 依赖这个记号）',
    );

    // WebUI 解析层必须处理 <voice>
    const txSrc = src('webui-src/sessionTranscript.ts');
    assert.ok(/const voiceRe = \/<voice>/.test(txSrc), 'sessionTranscript 应解析 <voice>');
    assert.ok(/'voice'/.test(txSrc), "ChatBubble.kind 应包含 'voice'");

    // 渲染层要给语音气泡专属类名
    const pageSrc = src('webui-src/pages/SessionsPage.tsx');
    assert.ok(/im-bubble--voice/.test(pageSrc), 'SessionsPage 应给语音气泡加 im-bubble--voice');
}

// —— 10. VoicePage：说明文案已删、引擎改胶囊 ——
{
    const voicePage = fs.readFileSync(path.join(root, 'webui-src/pages/VoicePage.tsx'), 'utf8');
    assert.ok(!/给 AI「发语音的能力」/.test(voicePage), '「给 AI 发语音的能力」说明应已删除');
    assert.ok(!/切换引擎后下方只显示该引擎需要的设置/.test(voicePage), '引擎切换说明应已删除');
    assert.ok(/mk-seg__btn/.test(voicePage), '引擎选择应改用胶囊按钮');
    assert.ok(/第三方配音/.test(voicePage) && /QQAI配音/.test(voicePage), '两个胶囊文案应为 第三方配音 / QQAI配音');
    assert.ok(!/<option value="qqai"/.test(voicePage), '引擎不应再是 <select>');
    // 引擎切换后仍只显示对应设置
    assert.ok(/engine === 'pearapi' \?/.test(voicePage), '保留「按引擎分支显示设置」的行为');
}

removeTmpDir(tmpDir);
console.log('verify-voice-display: all passed');
