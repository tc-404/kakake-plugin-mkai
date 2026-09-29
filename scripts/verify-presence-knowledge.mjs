/**
 * 存在感 / 会话知识架构回归（不依赖构建产物）
 * - prefer_silence TTL
 * - 开放问句开口激励
 * - lore 关键词分槽
 * - style pack 注入
 * - memory 写回/召回
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 以下启发式直接加载真实源码（原实现是本文件内联复刻 looksLikeOpenQuestion /
// refreshPreferSilence / PREFER_SILENCE_TTL_MS / selectLoreByKeys，
// 改阈值、换分支、加判据都不会被发现）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-presence-knowledge-'));

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

const typesMod = await loadModule('src/auth/smart-chat-types.ts');
const silenceMod = await loadModule('src/auth/smart-chat-silence.ts');
const knowledgeMod = await loadModule('src/auth/smart-chat-knowledge.ts');
const compactMod = await loadModule('src/auth/smart-chat-compact.ts');
const memoryMod = await loadModule('src/auth/smart-chat-memory.ts');

const {
    PREFER_SILENCE_TTL_MS,
    SMART_CHAT_ROOT,
    assembleSystemPromptBase,
} = typesMod;
const { looksLikeOpenQuestion, refreshPreferSilence, decideSilence } = silenceMod;
const { selectLoreByKeys, PROTOCOL_SYSTEM_SUFFIX } = knowledgeMod;
const {
    maybeCompactSession,
    isDigestMessage,
    COMPACT_MESSAGE_THRESHOLD,
    COMPACT_KEEP_TAIL,
} = compactMod;
const { sanitizeEpisodeSummary } = memoryMod;

// --- tests ---

assert.equal(looksLikeOpenQuestion('现在插件版本最新是多少呀？'), true, 'open Q');
assert.equal(looksLikeOpenQuestion('支持官BOT吗'), true, 'support Q');
assert.equal(looksLikeOpenQuestion('哈哈'), false, 'not Q');
// 原内联副本漏掉的分支（smart-chat-silence.ts:110）：谁会/谁懂/怎么办/咋整…
assert.equal(looksLikeOpenQuestion('谁懂这个报错'), true, 'who-knows Q');
assert.equal(looksLikeOpenQuestion('补充：帮你写个插件'), false, '补充 noise not Q');

{
  const s = { prefer_silence: true, prefer_silence_at: new Date(Date.now() - PREFER_SILENCE_TTL_MS - 1000).toISOString() };
  assert.equal(refreshPreferSilence(s), false, 'TTL expired clears');
  assert.equal(s.prefer_silence, false);
  assert.equal('prefer_silence_at' in s, false, 'TTL expired also drops timestamp');
}

{
  const s = { prefer_silence: true, prefer_silence_at: new Date().toISOString() };
  assert.equal(refreshPreferSilence(s), true, 'TTL fresh keeps');
}

{
  // 旧数据无时间戳：补一个「已过半 TTL」的起点，不永久粘住
  const s = { prefer_silence: true };
  assert.equal(refreshPreferSilence(s), true, 'no timestamp keeps');
  assert.ok(Number.isFinite(Date.parse(String(s.prefer_silence_at))), 'backfills prefer_silence_at');
}

{
  // 开口激励：真跑 decideSilence（原为 silence.includes('开口激励') 的源码文本代理）
  const d = decideSilence({
    session: { shut_up_streak: 4 },
    scene: { silenceBias: 'none', peerLoop: false, openFloor: true },
    silenceAllowedByConfig: true,
    atBot: false,
    batchText: '这插件怎么装？',
    shutUpLimit: 5,
  });
  assert.equal(d.openQuestion, true, 'open question detected');
  assert.equal(d.forceSpeak, false, 'not forced yet');
  assert.ok(
    d.hostSilenceHints.includes('开口激励：场上有开放问句，可短接一条'),
    'speak incentive',
  );
}

// lore：真跑 selectLoreByKeys（假 deps 只在内存里应答知识文件）
const GLOBAL_KB = `${SMART_CHAT_ROOT}knowledge/global.json`;
const GROUP_KB = `${SMART_CHAT_ROOT}knowledge/123456.json`;

function kbEntry(row) {
  return { enabled: true, priority: 0, ...row };
}

function kbDeps(files) {
  return { readA: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : undefined) };
}

const kbGlobalEntries = [
  kbEntry({ id: '1', kind: 'lore', keys: ['napcat'], title: 'NC', content: 'NapCat 相关', priority: 1 }),
  kbEntry({ id: '2', kind: 'skill', keys: ['napcat'], title: 'skill', content: 'x' }),
  kbEntry({ id: '3', kind: 'lore', keys: ['zzz'], title: 'Z', content: 'no' }),
  // 命中但被停用：不得进 lore 槽（优先级给到 99 也是拦住的证据）
  kbEntry({ id: '4', kind: 'lore', keys: ['napcat'], title: 'off', content: 'off', priority: 99, enabled: false }),
];

{
  const lore = selectLoreByKeys(
    kbDeps({ [GLOBAL_KB]: JSON.stringify({ entries: kbGlobalEntries }) }),
    '怎么装 napcat',
    null,
    4,
  );
  assert.equal(lore.length, 1);
  assert.equal(lore[0].id, '1');
}

{
  // 分群槽 + 全局槽合流，并按 priority 排序；maxEntries 截断
  const deps = kbDeps({
    [GROUP_KB]: JSON.stringify({
      entries: [kbEntry({ id: 'g1', kind: 'lore', keys: ['napcat'], title: 'G', content: 'group lore', priority: 9 })],
    }),
    [GLOBAL_KB]: JSON.stringify({ entries: kbGlobalEntries }),
  });
  assert.deepEqual(selectLoreByKeys(deps, 'napcat 怎么装', '123456', 4).map((e) => e.id), ['g1', '1']);
  assert.deepEqual(selectLoreByKeys(deps, 'napcat 怎么装', '123456', 1).map((e) => e.id), ['g1']);
  assert.deepEqual(selectLoreByKeys(deps, '跟知识库无关的话', '123456', 4), []);
}

{
  const stylePath = path.join(root, 'src', 'auth', 'style-packs', 'groupie.json');
  assert.ok(fs.existsSync(stylePath), 'groupie style pack exists');
  const pack = JSON.parse(fs.readFileSync(stylePath, 'utf8'));
  assert.ok(Array.isArray(pack.examples) && pack.examples.length >= 8, 'enough examples');
  assert.ok(!JSON.stringify(pack).includes('这波属实有点东西'), 'no quotable canned lines');
  assert.ok(pack.examples.some((e) => String(e.say || '').includes('自造一句')), 'vibe guidance');
}

{
  const types = fs.readFileSync(path.join(root, 'src', 'auth', 'smart-chat-types.ts'), 'utf8');
  // 真装配出的 system（原为 types.includes(...) 源码文本代理）
  const sys = assembleSystemPromptBase();
  assert.ok(sys.includes('用自己的话短接') || sys.includes('用「我」进场'), 'presence prompt updated');
  assert.ok(sys.includes('禁止旁白解说'), 'anti-narrator in locked prompt');
  assert.ok(!sys.includes('这波属实有点东西'), 'no canned style in system');
  assert.ok(!types.includes('这波属实有点东西'), 'no canned style in system source');
  // 1.3.1 去重：贴纸凑数约束只归 PROTOCOL 的表情包节
  assert.ok(PROTOCOL_SYSTEM_SUFFIX.includes('勿为凑建议条数硬发表情'), 'no sticker padding');
  assert.ok(!types.includes('勿为凑数硬发表情'), 'sticker padding rule not duplicated in types');
  assert.ok(types.includes('prefer_silence_at'), 'TTL field');
  assert.ok(types.includes("kind?: SmartChatKnowledgeKind"), 'knowledge kind');
}

{
  // compact 必须降级粘性闭嘴（原为 compact.includes('prefer_silence_at') 源码文本代理）
  const session = {
    messages: Array.from({ length: COMPACT_MESSAGE_THRESHOLD + 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}条：今天群里聊了 NapCat 的安装`,
    })),
    prefer_silence: true,
    prefer_silence_at: new Date().toISOString(),
  };
  maybeCompactSession(session);
  assert.equal(session.messages.length, COMPACT_KEEP_TAIL + 1, '1 条 digest + 尾');
  assert.ok(isDigestMessage(session.messages[0]), 'index 0 是 digest');
  assert.equal(session.prefer_silence, false, 'compact clears prefer_silence');
  assert.ok(!('prefer_silence_at' in session), 'compact clears prefer_silence_at');
}

{
  // memory 侧真实行为：episode 不得存 digest 壳 / 模板污染
  assert.equal(
    sanitizeEpisodeSummary(
      '<compaction-summary>\n[compact 2026-01-01]\n说明：以下为远史压缩。\n'
      + '<digest-stance>\n- 用户想装 NapCat\n</digest-stance>\n</compaction-summary>',
    ),
    '用户想装 NapCat',
    'episode 抽 stance 条',
  );
  assert.equal(sanitizeEpisodeSummary('<style-pack>…</style-pack> 今天聊了 NapCat'), '今天聊了 NapCat', '剥离 style-pack');
}

{
  const mem = fs.readFileSync(path.join(root, 'src', 'auth', 'smart-chat-memory.ts'), 'utf8');
  assert.ok(mem.includes('writebackFromCompact'), 'memory writeback');
  assert.ok(mem.includes('recallMemoryBlock'), 'memory recall');
}

{
  const compose = fs.readFileSync(path.join(root, 'src', 'auth', 'smart-chat-compose.ts'), 'utf8');
  assert.ok(compose.includes('styleBlock') || compose.includes('buildStylePackBlock'), 'style in compose');
  assert.ok(compose.includes('loreBlock') || compose.includes('buildLoreBlock'), 'lore in compose');
  assert.ok(compose.includes('memoryBlock'), 'memory in compose');
}

// Historical metrics snapshot (v7–v12) for regression narrative
// 注意：这是本文件内的字面量，不读 src、也不读任何度量产物 —— 断言恒真，只作叙事用。
const hist = [
  { v: 7, reply: 83.1 },
  { v: 8, reply: 74 },
  { v: 12, reply: 3.4 },
];
assert.ok(hist[0].reply > 40 && hist[2].reply < 10, 'baseline: v7 healthy, v12 collapsed');

console.log('verify-presence-knowledge: ok');
console.log(JSON.stringify({
  openQuestion: true,
  preferSilenceTtlMs: PREFER_SILENCE_TTL_MS,
  stylePack: 'groupie',
  targetReplyRate: '40-70%',
  baselines: hist,
}, null, 2));
