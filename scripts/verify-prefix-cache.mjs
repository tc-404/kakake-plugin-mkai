/**
 * Reasonix 前缀稳定验收（源码形状 + 真跑源码，不依赖构建产物）
 *
 * A) 源码形状：composeTurn 不对历史 strip/label/collapse；读史规则只在锁定 system 一处；
 *    前缀基准只有一个写入口（recordSentApiPrefix）
 * B) 算法：历史字节不变 → prefix hash 不变；strip 会破坏前缀
 * C) 静态/动态分离：只有动态输入变时，稳定 system 必须字节不变
 * D) 记账口径：真正发出的那轮才刷新基准 → 下一轮 prefixStable=true；
 *    预判沉默那轮不刷新 → 下一轮诚实报 false，不假报命中
 * E) 表情后缀：同一图库里文件数变动不动前缀；装/卸图库只重置一次
 *
 * 运行：npm run verify:prefix-cache
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const composeSrc = read('src/auth/smart-chat-compose.ts');
const typesSrc = read('src/auth/smart-chat-types.ts');
const sessionSrc = read('src/auth/smart-chat-session.ts');
const flushSrc = read('src/auth/smart-chat-flush.ts');
const fusionSrc = read('src/auth/smart-chat-persona-fusion.ts');
const providerSrc = read('src/auth/smart-chat-provider.ts');
// 1.3.1 去重：认人/读史规则统一归 PROTOCOL_SYSTEM_SUFFIX（knowledge.ts），types.ts 不再复述
const knowledgeSrc = read('src/auth/smart-chat-knowledge.ts');

// ------------------------------------------------------------------ A 源码形状
assert.ok(/读史：历史里 assistant/.test(knowledgeSrc), '锁定 system 应含读史规则');
assert.ok(!/读史：历史里 assistant/.test(typesSrc), '读史规则只留一处（PROTOCOL）');
assert.ok(!/parts\.push\(\s*[\s\S]*?读史：/.test(composeSrc), 'compose tip 不应再挂读史');
assert.ok(!/collapseRedundantShutUpHistory\s*\(/.test(composeSrc), 'composeTurn 禁止每轮 shut-up 折叠');
assert.ok(/migrateApiHistoryAlignment/.test(sessionSrc), '旧会话一次性迁移');
assert.ok(/baseSession/.test(sessionSrc), 'appendSessionTurn 应携带本轮 session');

const composeTurnFn = composeSrc.match(
  /export function composeTurn\([\s\S]*?\nexport function hashApiFullRequest/,
);
assert.ok(composeTurnFn, '定位 composeTurn');
const turnBody = composeTurnFn[0];
assert.ok(!/stripHistoryUserMeta\s*\(/.test(turnBody), 'composeTurn 内禁止 stripHistoryUserMeta');
assert.ok(!/labelAssistantHistoryForApi\s*\(/.test(turnBody), 'composeTurn 内禁止 labelAssistantHistoryForApi');
assert.ok(/resolveFrozenSystemCaps/.test(turnBody), 'composeTurn 应冻结 system caps');
assert.ok(/hashApiPrefix\s*\(\s*systemPrompt\s*,\s*history\s*\)/.test(turnBody), '应计算 prefixHash');
assert.ok(!/sampleSpeakActionCount[\s\S]*?Math\.random/.test(composeSrc), '建议条数禁止 Math.random');

// 基准只准走 recordSentApiPrefix 一个口子：两处各写一套（含/不含 assistant）会永久 miss
const writers = composeSrc.match(/session\.last_api_prefix_hash\s*=/g) || [];
assert.strictEqual(writers.length, 1, `last_api_prefix_hash 只能有一处赋值，实测 ${writers.length}`);
assert.ok(/export function recordSentApiPrefix/.test(composeSrc), 'recordSentApiPrefix 应存在');
for (const [name, src] of [['flush', flushSrc], ['persona-fusion', fusionSrc]]) {
  assert.ok(/recordSentApiPrefix\(/.test(src), `${name} 应改用统一入口写基准`);
  assert.ok(!/last_api_prefix_hash\s*=/.test(src), `${name} 不应自己拼一套 hash`);
}
// 预判沉默那轮没发请求：写了基准，下一轮会假报命中
const skipLlmBlock = flushSrc.match(/if \(silenceDec\.skipLlm\)[\s\S]*?appendSessionTurn/);
assert.ok(skipLlmBlock, '定位预判沉默分支');
assert.ok(!/recordSentApiPrefix/.test(skipLlmBlock[0]), '预判沉默轮禁止刷新前缀基准');
// 命中统计要采上游字段，否则「没命中」与「上游没报」永远分不开（16 代 38 次请求全是 0）
assert.ok(/prompt_tokens_details|cached_tokens/.test(providerSrc), 'usage 归一应采 cached_tokens');
assert.ok(/cache_fields_reported/.test(providerSrc), '应区分「上游没报」与「真没命中」');

// ------------------------------------------------------------------ 真跑源码
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-'));
const cleanup = () => removeTmpDir(tmpDir);
const fail = (e) => {
  cleanup();
  throw e;
};

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

let compose;
try {
  compose = await loadModule('src/auth/smart-chat-compose.ts');
} catch (e) {
  fail(e);
}
const { composeTurn, hashApiPrefix, hashApiFullRequest, recordSentApiPrefix, sampleSpeakActionCount } = compose;

/** 'YYYY-MM-DD HH:mm:ss' 本地时间串（缓冲区里就是这个格式） */
function ts(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const SELF_ID = '2071521294';
function entry(over = {}) {
  const minutesAgo = Number(over.minutesAgo ?? 1);
  return {
    userId: '1001',
    nickname: '甘甜',
    text: '随便说点什么',
    messageId: 'm1',
    atQqs: [],
    ...over,
    time: over.time || ts(Date.now() - minutesAgo * 60000),
    eventSnapshot: { self_id: SELF_ID, message_type: 'group', group_id: '955682835' },
  };
}

const CONFIG = {
  system_prompt: '你是群里的「汐音」：测试用定义句。',
  action_min: 0,
  action_max: 3,
  shut_up_limit: 5,
  kb_top_m: 6,
  batch_max_age_ms: 120000,
};

const SKILLS = [
  { id: 's1', title: '呆猫图库', content: '呆猫用法说明。', tags: [], updated_at: '', enabled: true, kind: 'skill' },
];

function newSession(over = {}) {
  return {
    messages: [],
    shut_up_streak: 0,
    chat_type: 'group',
    group_id: '955682835',
    group_name: 'MK - Galgame交流群',
    bot_standing: '新成员',
    bot_role_label: '普通成员',
    bot_join_at: '2026-01-06 12:21:05',
    ...over,
  };
}

const OPTS = { botNickname: '汐音', chatId: 'g_955682835', stylePackId: 'groupie' };

try {
  // ---------------------------------------------------------------- B 哈希算法
  const n1 = sampleSpeakActionCount(0, 3, 'g|1|2|m1');
  assert.strictEqual(n1, sampleSpeakActionCount(0, 3, 'g|1|2|m1'), '同种子建议条数稳定');
  assert.ok(n1 >= 1 && n1 <= 3, '建议条数应落在允许区间');
  const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => sampleSpeakActionCount(1, 5, k)));
  assert.ok(spread.size >= 2, '不同种子应能落到不同建议条数');

  const hist = [
    { role: 'user', content: 'old tip with <host-state>x</host-state>' },
    { role: 'assistant', content: '<replies><msg>喵</msg></replies>' },
  ];
  assert.strictEqual(
    hashApiPrefix('SYS', hist),
    hashApiPrefix('SYS', hist.map((m) => ({ ...m }))),
    '历史字节不变 → 前缀 hash 不变',
  );
  const stripped = hist.map((m) => (m.role === 'user'
    ? { ...m, content: m.content.replace(/<host-state>[\s\S]*?<\/host-state>\s*/gi, '').trim() }
    : m));
  assert.notStrictEqual(hashApiPrefix('SYS', stripped), hashApiPrefix('SYS', hist), 'strip 会破坏前缀（对照）');

  const tipN = { role: 'user', content: 'tipN <host-state>y</host-state>' };
  assert.strictEqual(
    hashApiPrefix('SYS', [...hist, tipN, { role: 'assistant', content: '<shut_up/>' }].slice(0, -1)),
    hashApiFullRequest('SYS', [...hist, tipN]),
    'N+1 去掉尾部 assistant 后应等于 N 全文',
  );

  // ------------------------------------------------------- C 静态段不随动态段动
  const sepSession = newSession();
  const base = composeTurn(CONFIG, sepSession, [
    entry({ minutesAgo: 3, messageId: '101', text: '渔力全开有人玩吗' }),
    entry({ minutesAgo: 2, userId: '1002', nickname: '潇', messageId: '102', text: '你买了吗' }),
  ], SKILLS, 0, { ...OPTS, memoryBlock: '<memory-recall>\n· 人物 甘甜(1001)\n</memory-recall>' });

  // 只动「会变的东西」：沉默计数 / 偏好 / 批次内容 / 时间 / 艾特 / 召回 / 种子
  sepSession.shut_up_streak = 4;
  sepSession.prefer_silence = true;
  sepSession.prefer_no_reply = true;
  const drifted = composeTurn(CONFIG, sepSession, [
    entry({ minutesAgo: 30, userId: '1003', nickname: '寒愁洛', messageId: '777', text: '@汐音 你是机器人吗', atQqs: [SELF_ID] }),
  ], SKILLS, 0, { ...OPTS, chatId: 'g_955682835', memoryBlock: '<memory-recall>\n· 人物 寒愁洛(1003)\n</memory-recall>' });

  assert.strictEqual(drifted.systemPrompt, base.systemPrompt, '动态输入变化不得改写稳定 system');
  assert.notStrictEqual(drifted.userContentExact, base.userContentExact, '动态事实应落在本轮 user 里');
  // 规则文字（怎么读这些字段）归稳定 system；带数值的事实只准出现在本轮 user
  for (const [label, valueRe] of [['沉默计数', /沉默计数 \d+\/\d+/], ['行为数', /行为数 \d+-\d+/]]) {
    assert.ok(valueRe.test(drifted.userContentExact), `「${label}」的数值应留在 user turn`);
    assert.ok(!valueRe.test(base.systemPrompt), `「${label}」的数值不应进稳定 system`);
  }
  assert.ok(!/沉默计数 \d+\/\d+/.test(drifted.systemPrompt), '换了沉默计数也不该改写 system');

  // ------------------------------------------------- D 记账口径（真跑一条完整链）
  const s = newSession();
  const mkBatch = (i) => [entry({ minutesAgo: i, messageId: `20${i}`, text: `第 ${i} 批发言` })];

  const t1 = composeTurn(CONFIG, s, mkBatch(1), SKILLS, 0, OPTS);
  assert.strictEqual(t1.prefixStable, false, '首轮没有基准 → 不该报命中');

  // 真发出去了：刷新基准，再把本轮 tip 与模型回复入史
  recordSentApiPrefix(s, t1.systemPrompt, t1.apiMessages);
  s.messages.push({ role: 'user', content: t1.userContentExact });
  s.messages.push({ role: 'assistant', content: '<replies><msg>玩过一点</msg></replies>' });

  const t2 = composeTurn(CONFIG, s, mkBatch(2), SKILLS, 0, OPTS);
  assert.strictEqual(t2.prefixStable, true, '发出的那轮刷了基准 → 下一轮应命中前缀');
  assert.strictEqual(t2.systemPrompt, t1.systemPrompt, '同会话 system 跨轮字节不变');

  recordSentApiPrefix(s, t2.systemPrompt, t2.apiMessages);
  s.messages.push({ role: 'user', content: t2.userContentExact });
  s.messages.push({ role: 'assistant', content: '<replies><msg>嗯</msg></replies>' });

  // 预判沉默：没发请求 → 不刷基准，但 tip 与 <shut_up/> 照样入史
  const t3 = composeTurn(CONFIG, s, mkBatch(3), SKILLS, 0, OPTS);
  assert.strictEqual(t3.prefixStable, true, '上一轮发出过 → 本轮仍应命中');
  s.messages.push({ role: 'user', content: t3.userContentExact });
  s.messages.push({ role: 'assistant', content: '<shut_up/>' });

  const t4 = composeTurn(CONFIG, s, mkBatch(4), SKILLS, 0, OPTS);
  assert.strictEqual(t4.prefixStable, false, '跳过 LLM 的那轮 tip 服务端没见过 → 必须诚实报 miss');

  recordSentApiPrefix(s, t4.systemPrompt, t4.apiMessages);
  s.messages.push({ role: 'user', content: t4.userContentExact });
  s.messages.push({ role: 'assistant', content: '<replies><msg>回来了</msg></replies>' });
  assert.strictEqual(
    composeTurn(CONFIG, s, mkBatch(5), SKILLS, 0, OPTS).prefixStable,
    true,
    '重新发出后应立刻恢复命中',
  );

  // 人设融合预热与正式访问共用同一个写入口 → 预热完那轮也算命中
  const warm = newSession();
  const w1 = composeTurn(CONFIG, warm, mkBatch(1), SKILLS, 0, OPTS);
  recordSentApiPrefix(warm, w1.systemPrompt, w1.apiMessages);
  warm.messages.push({ role: 'user', content: w1.userContentExact });
  warm.messages.push({ role: 'assistant', content: '<replies><msg>预热</msg></replies>' });
  assert.strictEqual(
    composeTurn(CONFIG, warm, mkBatch(2), SKILLS, 0, OPTS).prefixStable,
    true,
    '预热口径应与 flush 一致（旧实现把 assistant 也算进去 → 之后永久 false）',
  );

  // ------------------------------------------------- E 表情后缀按「已装图库」冻结
  const stk = newSession();
  const stkOpts = (text, key) => ({
    ...OPTS,
    stickerOutput: true,
    stickerSystemSuffix: text,
    stickerInstallKey: key,
  });
  const e1 = composeTurn(CONFIG, stk, mkBatch(1), SKILLS, 0, stkOpts('<sticker-pick>呆猫 12 张</sticker-pick>', '呆猫|嘴替'));
  assert.ok(e1.systemPrompt.includes('呆猫 12 张'), '表情后缀应进稳定 system');
  // 图库内文件数变动（安装任务还在写盘 / 手动加了几张）：key 不变 → 前缀一个字节都不能动
  const e2 = composeTurn(CONFIG, stk, mkBatch(2), SKILLS, 0, stkOpts('<sticker-pick>呆猫 37 张</sticker-pick>', '呆猫|嘴替'));
  assert.strictEqual(e2.systemPrompt, e1.systemPrompt, '同一图库文件数变动不得改写已冻结后缀');
  // 装了新图库：key 变 → 只重置一次，之后重新稳定
  const e3 = composeTurn(CONFIG, stk, mkBatch(3), SKILLS, 0, stkOpts('<sticker-pick>呆猫+新库</sticker-pick>', '呆猫|嘴替|新库'));
  assert.notStrictEqual(e3.systemPrompt, e1.systemPrompt, '装/卸图库应重新冻结一次');
  const e4 = composeTurn(CONFIG, stk, mkBatch(4), SKILLS, 0, stkOpts('<sticker-pick>呆猫+新库 99 张</sticker-pick>', '呆猫|嘴替|新库'));
  assert.strictEqual(e4.systemPrompt, e3.systemPrompt, '重新冻结后应立即恢复稳定');

  console.log('verify-prefix-cache: ok');
  console.log(JSON.stringify({
    systemChars: base.systemPrompt.length,
    userTurnChars: base.userContentExact.length,
    prefixHash: base.prefixHash,
  }, null, 2));
} catch (e) {
  fail(e);
}

cleanup();
