/**
 * 19 代实测回归修复的固化断言：digest 质量 / 台词复读链 / 群管验证码消毒 / 别名撞名。
 *
 * 实测问题（2026-10-30 数据包）：
 * 1. digest 里出现 9 处 …[compact truncated]… 内部标记、同段内容重复拼接（head/tail 窗口重叠）
 * 2. digest-stance 收录机器人自己的台词 → episode → 每轮召回 → 原样复读
 * 3. 群管验证块（含验证码 5651）完整注入上下文
 * 4. 「小鱼」的改名别名「大肥鱼」撞了另一个人的现昵称
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-digest-'));
async function loadModule(relTsPath) {
    const outfile = path.join(tmpDir, `${path.basename(relTsPath, '.ts')}.cjs`);
    await build({
        entryPoints: [path.join(root, relTsPath)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        logLevel: 'silent',
        external: ['extract-zip'],
    });
    return createRequire(import.meta.url)(outfile);
}

const compact = await loadModule('src/auth/smart-chat-compact.ts');
const memory = await loadModule('src/auth/smart-chat-memory.ts');
const safety = await loadModule('src/auth/smart-chat-safety.ts');

// --- 1) digest 结构：无截断标记、无 assistant 台词块、体积受控 ---
{
    const batches = [];
    for (let i = 0; i < 30; i++) {
        batches.push({
            role: 'user',
            content: `<host-state>\n沉默计数 ${i % 6}\n</host-state>\n<batch-messages>\n`
                + `[2026-10-28 1${i % 10}:1${i % 6}:00] 外界☆群友${i}(${1000000 + i}) [成员] [msgid:${9000000 + i}]: `
                + `这是第${i}批消息，聊到了${i % 2 ? '服务器配置' : '表情包'}，内容重复铺底占用上下文。`.repeat(8)
                + `\n</batch-messages>`,
        });
        batches.push({ role: 'assistant', content: `<replies>\n<msg>第${i}批的回复台词，绝不能进摘要</msg>\n</replies>` });
    }
    const digest = compact.buildDigestContent(batches);
    assert.ok(digest.includes('<compaction-summary>'), 'digest 壳保留');
    assert.ok(!digest.includes('compact truncated'), '不得出现内部截断标记（19 代 9 处）');
    assert.ok(!digest.includes('<digest-assistants>'), 'assistant 台词块已移除（复读链根因）');
    assert.ok(!digest.includes('绝不能进摘要'), 'assistant 台词不得进 digest');
    assert.ok(digest.length < 4000, `行级采样后 digest 应远小于旧版（7304），实际=${digest.length}`);
    assert.ok(compact.isDigestMessage({ role: 'user', content: digest }), '生成的 digest 仍被判定认成 digest');
}

// --- 2) head/tail 重叠消除：短正文不得在 digest 里出现两次 ---
{
    const short = {
        role: 'user',
        content: '<batch-messages>\n[2026-10-28 12:00:00] 外界☆短消息(111111) [成员] [msgid:222222]: 短正文验证重叠\n</batch-messages>',
    };
    const digest = compact.buildDigestContent([short, { role: 'assistant', content: '<shut_up/>' }]);
    const hits = digest.split('短正文验证重叠').length - 1;
    assert.strictEqual(hits, 1, `短正文在 digest 中出现 ${hits} 次（旧版 head+tail 重叠=2 次）`);
}

// --- 3) stance 只认群友约定句；机器人台词形态一律不进 ---
{
    const digest = compact.buildDigestContent([
        {
            role: 'user',
            content: '<batch-messages>\n'
                + '[2026-10-28 12:00:00] 外界☆阿伟(333333) [成员] [msgid:444444] [艾特:2071521294]: 以后叫我阿伟就行\n'
                + '</batch-messages>',
        },
        {
            role: 'assistant',
            content: '<replies>\n<msg>干嘛，叫我就叫我不许说别的啊</msg>\n</replies>',
        },
    ]);
    assert.ok(digest.includes('以后叫我阿伟就行'), '群友约定句应进 stance');
    assert.ok(!digest.includes('不许说别的'), '机器人反问台词不得进 stance/正文');
    assert.ok(compact.looksLikeStanceLine('以后叫我阿伟就行'), '约定句判据为真');
    assert.ok(!compact.looksLikeStanceLine('干嘛，叫我就叫我不许说别的啊'), '反问台词判据为假');
    assert.ok(!compact.looksLikeStanceLine('厉害厉害，跨洋叫我闭嘴，你这份执着我收下了'), '19 代实测台词判据为假');
    assert.ok(!digest.includes('主访问：') && !digest.includes('次访问：'), '实时调用的访问引导语不得固化进 digest');

    assert.ok(compact.notScriptLine('用户想装 NapCat'), '松判据放行正常意图要点');
    assert.ok(!compact.notScriptLine('你到底什么时候好啊？'), '问句被松判据拦');
}

// --- 4) episode 侧：台词形态 stance 条目不进记忆；合法约定保留 ---
{
    const dirty = '<compaction-summary>\n[compact 2026-09-30T13:48:00.220Z]\n'
        + '<digest-stance>\n- 重装完内存倒是清爽了，绕这么一大圈最后回到原点，我早就说过啦\n'
        + '- 干嘛，叫我就叫我不许说别的啊\n- 以后叫我阿伟就行\n</digest-stance>\n</compaction-summary>';
    const out = memory.sanitizeEpisodeSummary(dirty);
    assert.strictEqual(out, '以后叫我阿伟就行', `台词条目应被清洗，实际=${JSON.stringify(out)}`);
}

// --- 5) 群管验证码消毒 ---
{
    assert.strictEqual(
        safety.sanitizeHostOpText(
            'QQ(1523142198)通过入群审核，已同意进入～\n请在10分钟内发送一下内容进行验证是否活人！\n[验证方式]:随机数字\n[验证内容]:5651\n[可以机会]:5次',
        ),
        safety.HOST_OP_NOTICE_TEXT,
        '纯验证消息整体替换',
    );
    const mixed = safety.sanitizeHostOpText('刚看到[验证内容]:5651 这个群管真逗');
    assert.ok(!/\b5651\b/.test(mixed), '混排消息里验证码本体必须被遮蔽');
    assert.ok(mixed.includes('这个群管真逗'), '混排消息其余正文保留');
    assert.strictEqual(safety.sanitizeHostOpText('今天天气不错'), '今天天气不错', '普通消息不动');
}

// --- 6) 别名撞名保护 ---
{
    const deps = {
        readA: () => '',
        writeA: (_p, c) => { deps._saved = c; },
    };
    const mem = { people: [], episodes: [] };
    memory.touchPeopleFromBatch(mem, [
        { userId: '3851407577', nickname: '外界☆大肥鱼' },
    ]);
    memory.touchPeopleFromBatch(mem, [
        { userId: '2053675737', nickname: '外界☆大肥鱼' },
    ]);
    memory.touchPeopleFromBatch(mem, [
        { userId: '2053675737', nickname: '外界☆小鱼' },
    ]);
    const xiaoyu = mem.people.find((p) => p.user_id === '2053675737');
    assert.ok(!xiaoyu.aliases.includes('外界☆大肥鱼'), `改名旧昵撞他人现昵称不得记别名，实际=${JSON.stringify(xiaoyu.aliases)}`);
}

// --- 7) 召回标注：近事行带防复读说明 ---
{
    const block = memory.recallMemoryBlock(
        {
            people: [],
            episodes: [{ id: 'e1', summary: '以后叫我阿伟就行', people: [], at: new Date().toISOString() }],
        },
        [],
        4,
        2,
        '999999',
    );
    assert.ok(block.includes('近事'), '召回行改用「近事」');
    assert.ok(block.includes('禁止原样复读'), '召回说明必须带防复读标注');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('verify-digest-quality: all passed');
