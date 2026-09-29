/**
 * 会话气泡：识图备注挂原图、引用/艾特可解析、批次内按时间排序
 *
 * 原实现把 sessionTranscript.ts 的逻辑在本文件里内联复刻了一遍（collect /
 * extractBracketTag / parseSpeaker / finalizeInboundDisplayText）——改阈值、
 * 换分支、动正则都不会被发现。现在全部走 esbuild 加载的真实源码：
 *   - 备注收集/挂载：真实 collectImageNotesMap / notesForMessage / sessionToBubbles
 *   - 夹具由真实**生产侧**构造器生成（smart-chat-image / smart-chat-inbound），
 *     闭合成「生产 → 消费」契约，而不是手抄一份格式字符串
 * 说明：extractBracketTag / parseMetaTags / parseInboundLine /
 * finalizeInboundDisplayText / sortInboundBubbles 在 sessionTranscript.ts 里都没有
 * export，只能通过真实 sessionToBubbles 的可观测输出间接覆盖（也是它们唯一的调用路径）。
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
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-transcript-'));

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
    const transcript = await loadModule('webui-src/sessionTranscript.ts');
    const image = await loadModule('src/auth/smart-chat-image.ts');
    const inbound = await loadModule('src/auth/smart-chat-inbound.ts');

    const {
        sessionToBubbles,
        collectImageNotesMap,
        notesForMessage,
        avatarLetter,
        groupRoleLabel,
    } = transcript;
    const { buildImagePlaceholderLine, buildImageSupplementLine, formatEyesVisionLine } = image;
    const { formatReplyMetaTag, formatAtMetaTag, formatGroupRoleTag } = inbound;

    // SessionsPage.tsx 从 sessionTranscript 导入这三个；导出消失即页面直接崩
    assert.strictEqual(typeof sessionToBubbles, 'function');
    assert.strictEqual(typeof avatarLetter, 'function');
    assert.strictEqual(typeof groupRoleLabel, 'function');

    // -------------------------------------------------------------------------
    // 1) 识图备注必须挂到原图气泡上（真实生产侧 → 真实消费侧）
    // -------------------------------------------------------------------------
    const MID = '727420603';
    // 真实 parseInboundLine 的发言人正则是 /^(.+?)\((\d{5,15})\)\s+/：QQ 必须 5-15 位数字
    const QQ_A = '10001';
    const QQ_B = '22222';
    // 生产侧真实构造器：占位行（入站即写）+ 眼睛备注（异步识图完成后写）
    const placeholderLine = buildImagePlaceholderLine(MID, 1);
    assert.strictEqual(placeholderLine, `${MID} 发了1张[图片](图片资源正在解析，也可能没有)`);
    const eyesLine = formatEyesVisionLine(MID, 1, '一只猫在沙发上');
    assert.strictEqual(eyesLine, `[眼睛 msgid:${MID} 第1张]: 一只猫在沙发上`);

    const imgSession = {
        bot_nickname: '沐沐',
        messages: [
            {
                role: 'user',
                // 同一轮里：带时间戳的占位行 + 纯眼睛备注行（formatBatchLines 对眼睛行不挂昵称）
                content: `[2026-08-04 15:08:13] 甲(${QQ_A}) [msgid:${MID}]: ${placeholderLine}\n${eyesLine}`,
            },
        ],
    };

    const notesMap = collectImageNotesMap(imgSession.messages);
    assert.deepStrictEqual(
        notesForMessage(notesMap, MID),
        ['一只猫在沙发上'],
        'collectImageNotesMap 应认出真实 formatEyesVisionLine 产出的备注行',
    );

    const imgBubbles = sessionToBubbles(imgSession);
    const imgBubble = imgBubbles.find((b) => b.messageId === MID);
    assert.ok(imgBubble, '图片消息必须产生气泡');
    assert.strictEqual(imgBubble.side, 'in');
    assert.strictEqual(imgBubble.text, '[图片]', '占位/解析提示要剥掉，正文退化为 [图片]');
    assert.strictEqual(imgBubble.name, '甲');
    assert.strictEqual(imgBubble.qq, QQ_A);
    assert.strictEqual(imgBubble.time, '2026-08-04 15:08:13');
    assert.deepStrictEqual(
        imgBubble.imageNotes,
        ['一只猫在沙发上'],
        '识图备注要挂在原图气泡上，不能另起一条',
    );
    assert.strictEqual(
        imgBubbles.filter((b) => b.kind === 'eyes').length,
        0,
        '已挂到原图的备注不应再产生孤儿气泡',
    );

    // 多张图：notesForMessage 必须带「第N张」前缀
    const supplementLine = buildImageSupplementLine(MID, 2, '第二张是狗');
    assert.strictEqual(supplementLine, `补充：${MID} 图片第2张解析结果 第二张是狗`);
    const twoMap = collectImageNotesMap([
        { role: 'user', content: `${eyesLine}\n${supplementLine}` },
    ]);
    assert.deepStrictEqual(notesForMessage(twoMap, MID), [
        '第1张：一只猫在沙发上',
        '第2张：第二张是狗',
    ]);

    // 2) 原图气泡不在场时，备注不能静默丢失（孤儿兜底）
    const orphanBubbles = sessionToBubbles({ messages: [{ role: 'user', content: eyesLine }] });
    assert.strictEqual(orphanBubbles.length, 1);
    assert.strictEqual(orphanBubbles[0].kind, 'eyes');
    assert.strictEqual(orphanBubbles[0].side, 'sys');
    assert.strictEqual(orphanBubbles[0].messageId, MID);
    assert.deepStrictEqual(orphanBubbles[0].imageNotes, ['一只猫在沙发上']);

    // -------------------------------------------------------------------------
    // 3) 引用摘要含 [图片]：方括号段不能提前截断（真实标签构造器 → 真实解析）
    // -------------------------------------------------------------------------
    const replyTag = formatReplyMetaTag({
        replyToId: '1769057085',
        replyToUserId: '3780607382',
        replyToNickname: '外界☆Apathy.',
        replyToSnippet: '[图片]',
    });
    const atTag = formatAtMetaTag(['3780607382'], new Map([['3780607382', '外界☆Apathy.']]));
    const replyLine =
        `[2026-08-24 20:05:36] 甲(${QQ_A})${formatGroupRoleTag('member')} [msgid:1237330697]`
        + `${replyTag}${atTag}: 哪个平台`;
    const [replyBubble] = sessionToBubbles({ messages: [{ role: 'user', content: replyLine }] });

    assert.ok(replyBubble, '带引用/艾特的行必须能解析出气泡');
    assert.ok(
        replyBubble.replyTo.includes('[图片]'),
        `引用摘要里的 [图片] 被提前截断：${replyBubble.replyTo}`,
    );
    assert.ok(replyBubble.replyTo.startsWith('引用 外界☆Apathy.(3780607382)'));
    assert.strictEqual(replyBubble.atTargets, '@ 外界☆Apathy.(3780607382)');
    assert.strictEqual(replyBubble.groupRole, 'member', '[成员] 应解析成群身份');
    assert.strictEqual(replyBubble.text, '哪个平台', '标签不能漏进正文');
    assert.strictEqual(groupRoleLabel(replyBubble.groupRole), '成员');
    assert.strictEqual(avatarLetter('外界☆寒愁洛'), '外');

    // -------------------------------------------------------------------------
    // 4) 引用标注里的 (QQ) 不能抢行首发信人匹配
    // -------------------------------------------------------------------------
    const hanLine =
        `[2026-08-24 20:05:36] 外界☆寒愁洛(3096145886)${formatGroupRoleTag('member')} [msgid:1237330697]`
        + `${formatReplyMetaTag({
            replyToId: '300396081',
            replyToUserId: '864264375',
            replyToNickname: '外界☆三个句号',
            replyToSnippet: '[图片]',
        })}${formatAtMetaTag(['864264375'], new Map([['864264375', '外界☆三个句号']]))}: 谁家的`;
    const [hanBubble] = sessionToBubbles({ messages: [{ role: 'user', content: hanLine }] });
    assert.strictEqual(hanBubble.qq, '3096145886', '行首昵称(QQ) 才是发言人，引用里的 (QQ) 不算');
    assert.strictEqual(hanBubble.name, '外界☆寒愁洛');
    assert.strictEqual(hanBubble.text, '谁家的');
    assert.strictEqual(hanBubble.groupRole, 'member');

    // -------------------------------------------------------------------------
    // 5) 入站正文净化：占位剥离 / [图片] / （空消息）
    // -------------------------------------------------------------------------
    const mergedBubbles = sessionToBubbles({
        messages: [
            {
                role: 'user',
                content: '[2026-08-04 15:08:13] 甲(' + QQ_A + ') [msgid:173483298]: 运行了几个小时了，还有4个没做'
                    + `\n${buildImagePlaceholderLine('173483298', 1)}`,
            },
        ],
    });
    assert.strictEqual(mergedBubbles.length, 1, '图片占位续行不应单独成泡');
    assert.strictEqual(mergedBubbles[0].text, '运行了几个小时了，还有4个没做');

    const onlyImage = sessionToBubbles({
        messages: [
            {
                role: 'user',
                content: `[2026-08-04 15:08:13] 甲(${QQ_A}) [msgid:173483298]: ${buildImagePlaceholderLine('173483298', 1)}`,
            },
        ],
    });
    assert.strictEqual(onlyImage[0].text, '[图片]');

    const emptyMsg = sessionToBubbles({
        messages: [{ role: 'user', content: `[2026-08-04 15:08:13] 甲(${QQ_A}) [成员]: ` }],
    });
    assert.strictEqual(emptyMsg[0].text, '（空消息）');

    // -------------------------------------------------------------------------
    // 6) 同一批内按时间排序，同秒按 msgid 数值序（不是字典序）
    // -------------------------------------------------------------------------
    const timeSorted = sessionToBubbles({
        messages: [
            {
                role: 'user',
                content: [
                    `[2026-08-24 20:05:40] 乙(${QQ_B}) [成员] [msgid:200]: 后来`,
                    `[2026-08-24 20:05:36] 甲(${QQ_A}) [成员] [msgid:100]: 先发`,
                ].join('\n'),
            },
        ],
    });
    assert.deepStrictEqual(timeSorted.map((b) => b.text), ['先发', '后来']);

    const idSorted = sessionToBubbles({
        messages: [
            {
                role: 'user',
                content: [
                    `[2026-08-24 20:05:36] 甲(${QQ_A}) [成员] [msgid:1000]: 后 id`,
                    `[2026-08-24 20:05:36] 乙(${QQ_B}) [成员] [msgid:900]: 前 id`,
                ].join('\n'),
            },
        ],
    });
    assert.deepStrictEqual(
        idSorted.map((b) => b.messageId),
        ['900', '1000'],
        '同秒应按 msgid 数值序，而不是 "1000" < "900" 的字典序',
    );

    // -------------------------------------------------------------------------
    // 7) 会话气泡只读 WebUI 展示层：不得出现对话框出站函数
    // -------------------------------------------------------------------------
    const src = fs.readFileSync(path.join(root, 'webui-src/sessionTranscript.ts'), 'utf8');
    assert.ok(!/flushEyes/.test(src), 'sessionTranscript 不该引用出站 flushEyes');

    // SessionsPage.tsx / styles.css 是 JSX 与 CSS，import 不了，只能钉 wiring（挂载点 + 样式类）
    const page = fs.readFileSync(path.join(root, 'webui-src/pages/SessionsPage.tsx'), 'utf8');
    assert.ok(page.includes('im-bubble-eyes'));
    assert.ok(page.includes('im-msg-meta'));
    assert.ok(page.includes('imageNotes'));

    const css = fs.readFileSync(path.join(root, 'webui-src/styles.css'), 'utf8');
    assert.ok(css.includes('.im-bubble-eyes'));
    assert.ok(css.includes('.im-msg-meta__chip'));
} finally {
    removeTmpDir(tmpDir);
}

console.log('verify-session-transcript: all passed');
