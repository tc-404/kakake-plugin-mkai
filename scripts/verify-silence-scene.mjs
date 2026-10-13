/**
 * 结构场况回归（不依赖构建产物；与 smart-chat-scene / reply 启发式对齐）
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const BOT_NICK_FALLBACK = '群友';

function entry(partial) {
  return {
    userId: '',
    nickname: '',
    text: '',
    time: '',
    atQqs: undefined,
    replyToUserId: undefined,
    groupRole: undefined,
    eventSnapshot: { self_id: '2071521294' },
    ...partial,
  };
}

function entryAtsBot(e, selfId) {
  const sid = String(selfId || '').trim();
  if (!sid) return false;
  return (e.atQqs || []).some((q) => String(q).trim() === sid);
}

function entryQuotesBot(e, selfId) {
  const sid = String(selfId || '').trim();
  if (!sid) return false;
  return String(e.replyToUserId || '').trim() === sid;
}

function isNoiseText(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^\[眼睛\s+msgid:/i.test(t)) return true;
  if (/^补充：/.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 以下启发式直接加载真实源码（原实现是本文件内联复刻，改阈值/换分支都不会被发现）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-scene-'));

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
    return import(`file://${outfile.replace(/\\/g, "/")}`);
}

const sceneMod = await loadModule('src/auth/smart-chat-scene.ts');
const silenceMod = await loadModule('src/auth/smart-chat-silence.ts');
const replyMod = await loadModule('src/auth/smart-chat-reply.ts');
const composeMod = await loadModule('src/auth/smart-chat-compose.ts');
const stickerMod = await loadModule('src/auth/smart-chat-sticker.ts');

const {
    assessBatchScene,
    detectPeerLoop,
    detectOpenFloor,
    detectAlternatingPeerChat,
    batchAddressedToBot,
} = sceneMod;
const { decideSilence } = silenceMod;
const {
    refineOutboundByScene,
    looksLikeEchoOfHumans,
    looksLikeNarratorCommentary,
    normalizeEchoText,
} = replyMod;
const { detectSpeakPreference } = composeMod;
const { batchWantsStickerText } = stickerMod;

const SELF = '2071521294';

// 1) 两人互 @ → hard（无管理身份依赖）
{
  const batch = [
    entry({ userId: '111', text: '你好', atQqs: ['222'], groupRole: 'member' }),
    entry({ userId: '222', text: '在的', atQqs: ['111'], groupRole: 'member' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.silenceBias, 'hard');
  assert.strictEqual(s.atBot, false);
  assert.ok(s.hostLines.includes('拓扑: 两人互指'));
}

// 2) 管理互聊 + 互引用 → hard（证明不靠身份）
{
  const batch = [
    entry({
      userId: '864264375',
      text: '用的还是 JavaScript',
      replyToUserId: '3143278852',
      groupRole: 'admin',
    }),
    entry({
      userId: '3143278852',
      text: '依赖什么',
      atQqs: ['864264375'],
      groupRole: 'member',
    }),
    entry({
      userId: '864264375',
      text: '目前支持连接 nc',
      atQqs: ['3143278852'],
      groupRole: 'admin',
    }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.silenceBias, 'hard', 'admin chat must still hard by structure');
  assert.ok(!s.hostLines.some((l) => /管理|群主/.test(l)));
}

// 3) @ bot → none
{
  const batch = [
    entry({ userId: '111', text: '你怎么看', atQqs: [SELF], groupRole: 'admin' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.atBot, true);
  assert.strictEqual(s.silenceBias, 'none');
}

// 4) 昵称点名 → none
{
  const batch = [entry({ userId: '111', text: '沐沐沐沐在吗', groupRole: 'member' })];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.atBot, true);
  assert.strictEqual(s.silenceBias, 'none');
}

// 5) 未点名闲聊无问句 → none（不再默认 soft）
{
  const batch = [
    entry({ userId: '111', text: '今天好热', groupRole: 'member' }),
    entry({ userId: '222', text: '是啊', groupRole: 'owner' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.silenceBias, 'none');
}

// 6) 开放问句无指向 → none（模型自判）
{
  const batch = [entry({ userId: '111', text: '有没有人懂 napcat？', groupRole: 'member' })];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.silenceBias, 'none');
  assert.strictEqual(s.openFloor, true);
}

// 7) hard 出站压制
{
  const r = refineOutboundByScene(
    [{ type: 'msg', text: '对，主要是 JavaScript 开发喵～' }, { type: 'msg', text: '', sticker: '菲比/好诶.webp' }],
    { silenceAllowed: true, mustSpeak: false, silenceBias: 'hard', toolsUsed: false, actionMax: 6 },
  );
  assert.strictEqual(r.shutUp, true);
  assert.strictEqual(r.actions.length, 0);
  assert.strictEqual(r.rewritten, true);
}

// 8) soft 复读压制
{
  const r = refineOutboundByScene([{ type: 'msg', text: '用的还是 JavaScript 喵～' }], {
    silenceAllowed: true,
    mustSpeak: false,
    silenceBias: 'soft',
    toolsUsed: false,
    actionMax: 6,
    recentHumanTexts: ['用的还是 JavaScript'],
  });
  assert.strictEqual(r.shutUp, true);
  assert.strictEqual(r.rewritten, true);
}

// 8b) bias=none 也压制原句复读（v13）
{
  const r = refineOutboundByScene(
    [
      { type: 'msg', text: '你看看别人视角就知道了' },
      { type: 'msg', text: '', sticker: '菲比/好诶.webp' },
    ],
    {
      silenceAllowed: true,
      mustSpeak: false,
      silenceBias: 'none',
      toolsUsed: false,
      actionMax: 6,
      recentHumanTexts: ['你看看别人视角就知道了', '总之就是QQ版本问题'],
    },
  );
  assert.strictEqual(r.shutUp, true);
  assert.strictEqual(r.actions.length, 0);
  assert.strictEqual(r.rewritten, true);
}

// 8c) mustSpeak：剥重合字后只剩贴纸且未要图 → shut_up
{
  const r = refineOutboundByScene(
    [
      { type: 'msg', text: '复读机' },
      { type: 'msg', text: '', sticker: '菲比/1欸嘿.webp' },
    ],
    {
      silenceAllowed: true,
      mustSpeak: true,
      silenceBias: 'none',
      toolsUsed: false,
      actionMax: 6,
      recentHumanTexts: ['复读机'],
      batchWantsSticker: false,
    },
  );
  assert.strictEqual(r.shutUp, true);
  assert.strictEqual(r.actions.length, 0);
}

// 8d) mustSpeak + 要图：保留贴纸
{
  const r = refineOutboundByScene(
    [
      { type: 'msg', text: '复读机' },
      { type: 'msg', text: '', sticker: '菲比/1欸嘿.webp' },
    ],
    {
      silenceAllowed: true,
      mustSpeak: true,
      silenceBias: 'none',
      toolsUsed: false,
      actionMax: 6,
      recentHumanTexts: ['复读机'],
      batchWantsSticker: true,
    },
  );
  assert.strictEqual(r.shutUp, false);
  assert.ok(r.actions.some((a) => a.type === 'msg' && a.sticker === '菲比/1欸嘿.webp'));
}

// 8e) 旁白复盘出站闸
{
  assert.strictEqual(
    looksLikeNarratorCommentary([
      '这位1744老哥折腾一晚上终于找到了，感天动地，建议群友给他办个庆功宴',
    ]),
    true,
  );
  assert.strictEqual(looksLikeNarratorCommentary(['杠谁？我杠谁取决于谁先嘴硬']), false);
  const r = refineOutboundByScene(
    [{ type: 'msg', text: '孤尘自己艾特自己说禁言，这是什么新型自爆术' }],
    {
      silenceAllowed: true,
      mustSpeak: false,
      silenceBias: 'none',
      toolsUsed: false,
      actionMax: 6,
    },
  );
  assert.strictEqual(r.shutUp, true);
  assert.strictEqual(r.actions.length, 0);
  assert.strictEqual(r.rewritten, true);
}

// 9) soft 新信息放行
{
  const r = refineOutboundByScene([{ type: 'msg', text: '我觉得还是别急着买' }], {
    silenceAllowed: true,
    mustSpeak: false,
    silenceBias: 'soft',
    toolsUsed: false,
    actionMax: 6,
    recentHumanTexts: ['今天天气不错'],
  });
  assert.strictEqual(r.shutUp, false);
  assert.strictEqual(r.actions.length, 1);
}

// 10) 闭嘴偏好检测
assert.strictEqual(detectSpeakPreference('啊，你就是说你可以准备闭嘴吗？'), 'ban');
assert.strictEqual(detectSpeakPreference('闭嘴'), 'ban');
assert.strictEqual(detectSpeakPreference('你可以说话了'), 'ask');

// 11) prefer_silence + 未点名 → soft（非 hard）；点名仍 none
{
  const batch = [entry({ userId: '111', text: '随便聊聊', groupRole: 'member' })];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  const d = decideSilence({
    scene: s,
    silenceAllowedByConfig: true,
    atBot: s.atBot,
    batchText: '随便聊聊',
    session: { prefer_silence: true },
  });
  assert.strictEqual(d.sceneBias, 'soft');
  assert.strictEqual(d.skipLlm, false);
}

// 11b) 要表情未 @ → mustSpeak，不得 skip LLM
{
  const batch = [entry({ userId: '111', text: '来个表情包', groupRole: 'member' })];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  const d = decideSilence({
    session: {},
    scene: s,
    silenceAllowedByConfig: true,
    atBot: false,
    batchText: '来个表情包',
  });
  assert.strictEqual(d.mustSpeak, true);
  assert.strictEqual(d.batchWantsSticker, true);
  assert.strictEqual(d.skipLlm, false);
}

// 11c) peerLoop hard → 可 skip LLM
{
  const batch = [
    entry({ userId: '111', text: '你好', atQqs: ['222'], groupRole: 'member' }),
    entry({ userId: '222', text: '在的', atQqs: ['111'], groupRole: 'member' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  const d = decideSilence({
    session: {},
    scene: s,
    silenceAllowedByConfig: true,
    atBot: false,
    batchText: '你好\n在的',
  });
  assert.strictEqual(d.sceneBias, 'hard');
  assert.strictEqual(d.skipLlm, true);
}

// 12) 源码：沉默达上限不再强制开口；预判跳过 LLM
{
  const composeSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compose.ts'), 'utf8');
  assert.ok(composeSrc.includes('我的资历'));
  assert.ok(composeSrc.includes('我的群身份'));
  assert.ok(composeSrc.includes('我的入群'));
  assert.ok(composeSrc.includes('detectSpeakPreference'));
  assert.ok(composeSrc.includes('沉默: 达上限（本轮必须开口）'));
  assert.ok(!composeSrc.includes('沉默: 达上限（本轮禁止）'));
  assert.ok(!composeSrc.includes('（仅统计）'));

  const silenceSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-silence.ts'), 'utf8');
  assert.ok(silenceSrc.includes('prefer_silence'));
  assert.ok(silenceSrc.includes('refreshPreferSilence'));
  assert.ok(silenceSrc.includes('forceSpeak'));
  assert.ok(silenceSrc.includes('export function decideSilence'));
  assert.ok(silenceSrc.includes('skipLlm'));
  assert.ok(silenceSrc.includes('沉默: 达上限（本轮必须开口）'));

  const sceneSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-scene.ts'), 'utf8');
  assert.ok(!/groupRole/.test(sceneSrc), 'scene must not use groupRole');
  assert.ok(sceneSrc.includes('detectPeerLoop'));
  assert.ok(sceneSrc.includes('detectAlternatingPeerChat'));
  assert.ok(sceneSrc.includes('humans.length < 6'));

  const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
  assert.ok(flushSrc.includes('decideSilence'));
  assert.ok(flushSrc.includes('预判跳过 LLM'));
  assert.ok(flushSrc.includes('rewriteEnglishRefusal'));
  assert.ok(flushSrc.includes('forceSpeak'));
  assert.ok(!flushSrc.includes('biasSkip === \'hard\''));
  assert.ok(!flushSrc.includes('const mustSpeak = forceSpeak'));
  assert.ok(!flushSrc.includes('路过瞄一眼'));
  assert.ok(flushSrc.includes('looksLikeAuthorImpersonation'));
  assert.ok(flushSrc.includes('refreshPreferSilence'));
  assert.ok(flushSrc.includes('selectLoreByKeys'));
  assert.ok(flushSrc.includes('recallMemoryBlock'));
  assert.ok(flushSrc.includes('filterCooldownStickers'));
  assert.ok(flushSrc.includes('pushRecentStickers'));
  assert.ok(flushSrc.includes('batchWantsSticker: batchWantsStickerEarly'));
  assert.ok(flushSrc.includes('站位锁定仅写内存') || flushSrc.includes('首次 appendSessionTurn'));

  const replySrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-reply.ts'), 'utf8');
  assert.ok(replySrc.includes('batchWantsSticker'));
  assert.ok(replySrc.includes('forceSpeak'));
  assert.ok(replySrc.includes('常开反复读'));

  const sessionSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-session.ts'), 'utf8');
  assert.ok(sessionSrc.includes('pruneEmptySessions'));
  assert.ok(sessionSrc.includes('sessionRowHasContent'));

  const providerSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-provider.ts'), 'utf8');
  assert.ok(providerSrc.includes('maxAttempts'));
  // 1.3.2+：重试判据从「仅 5xx」扩到中转站抽风常见码（403/429/5xx/超时），
  // 两条协议路径都走 isRetryableStatus；401/无效密钥/余额不足仍算致命不重试。
  assert.ok(providerSrc.includes('isRetryableStatus'), 'provider 应统一用 isRetryableStatus 判断可重试状态码');
  assert.ok(
    /RETRYABLE_HTTP_STATUSES\s*=\s*new Set\(\[[^\]]*\b403\b[^\]]*\b429\b[^\]]*\]\)/.test(providerSrc),
    'RETRYABLE_HTTP_STATUSES 应包含 403 与 429（中转站间歇性拦截/限流）',
  );

  const stickerSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-sticker.ts'), 'utf8');
  assert.ok(stickerSrc.includes('RECENT_STICKER_LIMIT'));
  assert.ok(stickerSrc.includes('filterCooldownStickers'));
  assert.ok(stickerSrc.includes('禁止连刷同一张/同一三张'));

  const styleSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-style.ts'), 'utf8');
  assert.ok(styleSrc.includes('只学节奏与态度；右侧不是可发送原文'));
  assert.ok(!styleSrc.includes('这波属实有点东西'));
  assert.ok(!styleSrc.includes('你这结论下得有点早吧'));
  assert.ok(styleSrc.includes('短接一下现场，自造一句'));

  const groupieJson = fs.readFileSync(path.join(root, 'src/auth/style-packs/groupie.json'), 'utf8');
  assert.ok(!groupieJson.includes('这波属实有点东西'));
  assert.ok(groupieJson.includes('自造一句'));

  const typesSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-types.ts'), 'utf8');
  assert.ok(typesSrc.includes('recent_stickers'));
  assert.ok(typesSrc.includes('用自己的话短接'));
  // 1.3.1 去重：表情包细则只归 PROTOCOL（knowledge.ts）与 turn 尾提示，types.ts 不再复述
  assert.ok(!typesSrc.includes('勿为凑数硬发表情'));
  assert.ok(!typesSrc.includes('建议条数优先用贴纸'));

  const knowledgeSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-knowledge.ts'), 'utf8');
  assert.ok(!knowledgeSrc.includes('建议条数优先用贴纸填'));
  assert.ok(knowledgeSrc.includes('勿为凑建议条数硬发表情'));

  const safetySrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-safety.ts'), 'utf8');
  assert.ok(!safetySrc.includes('建议条数优先用 send_sticker 填'));

  const composeSrc2 = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compose.ts'), 'utf8');
  assert.ok(composeSrc2.includes('formatRecentStickerHostHint'));
  // 1.3 面板瘦身：host-state 的建议条数只留数值，凑数约束归 PROTOCOL 的表情包节
  assert.ok(!composeSrc2.includes('含字即可，勿为凑数硬发表情'));
  assert.ok(/建议条数 \$\{speakN\}`/.test(composeSrc2));
}

// 13) mustSpeak=false 时 hard 仍压制；mustSpeak 不应被 streak 单独打穿
{
  const r = refineOutboundByScene([{ type: 'msg', text: '了解' }], {
    silenceAllowed: true,
    mustSpeak: false,
    silenceBias: 'hard',
    toolsUsed: false,
    actionMax: 6,
  });
  assert.strictEqual(r.shutUp, true);
  assert.strictEqual(r.actions.length, 0);
}

// 14) 两人交替无 @ → peerLoop hard（须 ≥6 条）
{
  const batch = [
    entry({ userId: '111', text: '你那边版本多少', groupRole: 'member' }),
    entry({ userId: '222', text: '还是旧的', groupRole: 'member' }),
    entry({ userId: '111', text: '那你升一下', groupRole: 'member' }),
    entry({ userId: '222', text: '好', groupRole: 'member' }),
    entry({ userId: '111', text: '升完告诉我', groupRole: 'member' }),
    entry({ userId: '222', text: '行', groupRole: 'member' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.silenceBias, 'hard');
  assert.strictEqual(s.peerLoop, true);
}

// 15) streak≥limit → forceSpeak，不得 skipLlm（即使 peerLoop hard）
{
  const batch = [
    entry({ userId: '111', text: '你好', atQqs: ['222'], groupRole: 'member' }),
    entry({ userId: '222', text: '在的', atQqs: ['111'], groupRole: 'member' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  assert.strictEqual(s.silenceBias, 'hard');
  const d = decideSilence({
    session: {},
    scene: s,
    session: { shut_up_streak: 5 },
    silenceAllowedByConfig: true,
    atBot: false,
    batchText: '你好\n在的',
    shutUpLimit: 5,
  });
  assert.strictEqual(d.forceSpeak, true);
  assert.strictEqual(d.skipLlm, false);
  assert.strictEqual(d.sceneBias, 'none');
}

// 16) peerLoop + streak 达半限 → 不得 skipLlm
{
  const batch = [
    entry({ userId: '111', text: '你好', atQqs: ['222'], groupRole: 'member' }),
    entry({ userId: '222', text: '在的', atQqs: ['111'], groupRole: 'member' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  const d = decideSilence({
    session: {},
    scene: s,
    session: { shut_up_streak: 2 },
    silenceAllowedByConfig: true,
    atBot: false,
    batchText: '你好\n在的',
    shutUpLimit: 5,
  });
  assert.strictEqual(d.skipLlm, false);
  assert.notStrictEqual(d.sceneBias, 'hard');
}

// 17) forceSpeak 时 hard 不压制出站
{
  const r = refineOutboundByScene([{ type: 'msg', text: '了解' }], {
    silenceAllowed: true,
    mustSpeak: false,
    forceSpeak: true,
    silenceBias: 'hard',
    toolsUsed: false,
    actionMax: 6,
  });
  assert.strictEqual(r.shutUp, false);
  assert.strictEqual(r.actions.length, 1);
}

// 18) @ 机器人 → forceSpeak + mustSpeak
{
  const batch = [
    entry({ userId: '111', text: '在吗', atQqs: [SELF], groupRole: 'member' }),
  ];
  const s = assessBatchScene(batch, SELF, 'none', false, '沐沐沐沐');
  const d = decideSilence({
    session: {},
    scene: s,
    session: { shut_up_streak: 0 },
    silenceAllowedByConfig: true,
    atBot: true,
    batchText: '在吗',
    shutUpLimit: 5,
  });
  assert.strictEqual(d.mustSpeak, true);
  assert.strictEqual(d.forceSpeak, true);
  assert.strictEqual(d.skipLlm, false);
}

console.log('verify-silence-scene: all passed');
