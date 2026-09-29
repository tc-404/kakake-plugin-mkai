/**
 * 2.1 输出多样性验收（真跑函数）
 *
 * 覆盖：
 *   Style Pack（磁盘 + 内置回落）都带「一批里别重复同一句尾/开场」这条规则
 *   Style Pack 还要带 1.3.2 的「近几轮用过的开头/结尾句式换掉」（口头禅去重）
 *   formatRecentStyleHostHint 只报事实：近 N 轮自己用过的句尾符号、开场语气词、复读句式
 *   findRepeatedEdgePhrases 只看句首/句尾（中间的重复词多半是话题词，不是口头禅）
 *   沉默轮（只有 react / shut_up）不产生统计噪音
 *   提示进 turn 尾的 host-state，不进稳定 system（不打断前缀缓存）
 *
 * 运行：npm run verify:style
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

try {
    const style = await loadModule('src/auth/smart-chat-style.ts');
    const compose = await loadModule('src/auth/smart-chat-compose.ts');
    const disk = JSON.parse(
        fs.readFileSync(path.join(root, 'src/auth/style-packs/groupie.json'), 'utf8'),
    );

    // ------------------------------------------------------------ 规则落位
    const RULE = /别重复同一个句尾符号|别重复同一句尾/;
    const PHRASE_RULE = /开头\/结尾句式换掉|口头禅不是签名/;
    const diskRule = disk.examples.find((e) => RULE.test(e.say));
    assert.ok(diskRule, 'groupie.json 应有「一批里别重复同一句尾/开场」规则');
    const diskPhraseRule = disk.examples.find((e) => PHRASE_RULE.test(e.say));
    assert.ok(diskPhraseRule, 'groupie.json 应有「近几轮用过的开头/结尾句式换掉」规则（口头禅去重）');
    const packBlock = style.buildStylePackBlock('groupie');
    assert.ok(RULE.test(packBlock), 'Style Pack 稳定段应带上该规则');
    assert.ok(PHRASE_RULE.test(packBlock), 'Style Pack 稳定段应带上口头禅去重规则（12 条截断别把它切掉）');
    // 内置回落包（磁盘读失败时用）也得带，不然回落即失效
    const fallback = style.loadStylePack('__不存在的包__');
    assert.ok(fallback.examples.some((e) => RULE.test(e.say)), '内置回落包应带同一条规则');
    assert.ok(fallback.examples.some((e) => PHRASE_RULE.test(e.say)), '内置回落包也应带口头禅去重规则');

    // ------------------------------------------------------------ 只报事实
    const reply = (...msgs) => ({
        role: 'assistant',
        content: `<replies>${msgs.map((m) => `<msg>${m}</msg>`).join('')}</replies>`,
    });
    const hint = style.formatRecentStyleHostHint([
        { role: 'user', content: '群友说话' },
        reply('诶这个我知道～'),
        reply('哦？那不一样吧～', '哈哈行吧！'),
    ]);
    assert.ok(hint.includes('句尾'), `应报句尾符号，实测「${hint}」`);
    assert.ok(hint.includes('～'), '应抓到波浪号');
    assert.ok(hint.includes('！'), '应抓到叹号');
    assert.ok(hint.includes('开场'), '应报开场语气词');
    assert.ok(/诶/.test(hint) && /哦/.test(hint), '应抓到多个开场词');
    assert.ok(!/别|换一个|不要/.test(hint), 'turn 尾只报事实，规则不在这里重复');
    assert.ok(hint.length <= 60, `提示应压在一行内，实测 ${hint.length}`);

    // 去重：同一个句尾用三轮只报一次
    const dupe = style.formatRecentStyleHostHint([reply('好啊～'), reply('行～'), reply('嗯～')]);
    assert.strictEqual((dupe.match(/～/g) || []).length, 1, '重复符号只报一次');

    // 沉默轮 / 无历史：不产生噪音
    assert.strictEqual(style.formatRecentStyleHostHint([]), '', '无历史应为空');
    assert.strictEqual(
        style.formatRecentStyleHostHint([{ role: 'assistant', content: '<replies><react emoji="271" to="1"/></replies>' }]),
        '',
        '只 react 的沉默轮不该报句尾',
    );
    assert.strictEqual(
        style.formatRecentStyleHostHint([reply('这句没有符号收尾')]),
        '',
        '没有句尾符号也没有语气词开场时不报',
    );

    // 只看最近 rounds 轮
    const windowed = style.formatRecentStyleHostHint(
        [reply('老话！'), reply('新话～'), reply('更新～'), reply('最新～')],
        2,
    );
    assert.ok(!windowed.includes('！'), '超出窗口的轮次不该计入');

    // ------------------------------------------------------------ 口头禅去重（1.3.2）
    // 只看句首/句尾：中间的重复词多半是本轮话题词（表情包、图源），
    // 报出来只会让它绕开该说的词。
    const edges = style.findRepeatedEdgePhrases(['本小姐才不告诉你', '本小姐才不理你', '本小姐困了']);
    assert.deepStrictEqual(edges.heads, ['本小姐才不'], '同族短语只留最长的那个（「本小姐」被「本小姐才不」盖住）');
    assert.deepStrictEqual(edges.tails, [], '只撞 1 个字的结尾不算句式');
    assert.deepStrictEqual(
        style.findRepeatedEdgePhrases(['本小姐才不告诉你']).heads, [],
        '只说过一次不算复读',
    );
    const manyEdges = style.findRepeatedEdgePhrases([
        '啊啊测试一', '啊啊测试二', '哦哦别的一', '哦哦别的二', '呜呜第三一', '呜呜第三二',
    ]);
    assert.ok(manyEdges.heads.length <= 2, `最多报 2 条，别把 host-state 撑长（实测 ${manyEdges.heads.length}）`);

    const catchHead = style.formatRecentStyleHostHint([reply('本小姐才不告诉你'), reply('本小姐才不理你')]);
    assert.ok(catchHead.includes('口头禅'), `复读开头应报口头禅，实测「${catchHead}」`);
    assert.ok(catchHead.includes('本小姐才不'), '应抓到复读的开头句式');
    assert.ok(!/别|换一个|不要/.test(catchHead), '口头禅同样只报事实，规则在 Style Pack');

    const catchTail = style.formatRecentStyleHostHint([reply('这个我知道啦是不是呀'), reply('随便看看就好是不是呀')]);
    assert.ok(catchTail.includes('是不是呀'), `复读结尾应抓到，实测「${catchTail}」`);

    // 纯语气词开场已由「开场」统计报过，不重复列进口头禅
    const openerOnly = style.formatRecentStyleHostHint([reply('哈哈哈这也太离谱'), reply('哈哈哈草')]);
    assert.ok(openerOnly.includes('开场'), '应报开场语气词');
    assert.ok(!openerOnly.includes('口头禅'), `语气词开场不该再列一遍，实测「${openerOnly}」`);

    // @ 的对象不是口头禅
    const atLead = style.formatRecentStyleHostHint([reply('@甘甜 你自己看嘛'), reply('@甘甜 你自己想嘛')]);
    assert.ok(!atLead.includes('甘甜'), `@ 的对象不该被当成口头禅，实测「${atLead}」`);
    assert.ok(atLead.includes('你自己'), '去掉 @ 之后的句式仍要抓到');

    // 自己的昵称不算口头禅（人设写死的自称别拿这条去压）
    assert.strictEqual(
        style.formatRecentStyleHostHint([reply('汐音才不告诉你'), reply('汐音才不理你')], 3, { botNickname: '汐音' }),
        '',
        '含自己昵称的句式不报',
    );
    assert.ok(
        style.formatRecentStyleHostHint([reply('汐音才不告诉你'), reply('汐音才不理你')]).includes('汐音才不'),
        '没传昵称时照常按复读句式报（说明上面那条是昵称过滤生效，不是压根没抓到）',
    );

    // 三项齐发时也得压在一行内
    const full = style.formatRecentStyleHostHint([
        reply('诶本小姐才不告诉你～'),
        reply('诶本小姐才不理你～'),
    ]);
    assert.ok(/句尾/.test(full) && /开场/.test(full) && /口头禅/.test(full), `三项应同时出现，实测「${full}」`);
    assert.ok(full.length <= 80, `提示应压在一行内，实测 ${full.length}`);

    // ------------------------------------------------------------ 落位：turn 尾而非稳定 system
    const CONFIG = { system_prompt: '你是群里的「汐音」：测试用定义句。', action_min: 0, action_max: 3, shut_up_limit: 5, batch_max_age_ms: 120000 };
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const batch = [1, 2].map((i) => ({
        userId: `100${i}`,
        nickname: `群友${i}`,
        text: `第 ${i} 句`,
        time: stamp,
        messageId: `30${i}`,
        atQqs: [],
        eventSnapshot: { self_id: '2071521294', message_type: 'group', group_id: '955682835' },
    }));
    const session = {
        messages: [{ role: 'user', content: '旧的一轮' }, reply('上一轮这么收的～')],
        shut_up_streak: 0,
        chat_type: 'group',
        group_id: '955682835',
    };
    const turn = compose.composeTurn(CONFIG, session, batch, [], 0, { botNickname: '汐音', stylePackId: 'groupie' });
    const hostBlock = turn.userContentExact.match(/<host-state>([\s\S]*?)<\/host-state>/)?.[1] || '';
    assert.ok(/近 \d+ 轮自己已用/.test(hostBlock), `host-state 应带句尾/开场统计，实测「${hostBlock}」`);
    assert.ok(!/近 \d+ 轮自己已用/.test(turn.systemPrompt), '动态统计不得进稳定 system');

    console.log('verify-style-diversity: 全部通过');
} catch (e) {
    cleanup();
    throw e;
}

cleanup();