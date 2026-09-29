/**
 * Compaction 策略不变量与叠 digest 迁移回归（不调真实 API）
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 以下逻辑直接加载真实源码（原实现是本文件内联复刻：改阈值/换分支都不会被发现）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-compact-'));

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

const compactSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compact.ts'), 'utf8');
const sessionSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-session.ts'), 'utf8');

const compactMod = await loadModule('src/auth/smart-chat-compact.ts');
const {
    COMPACT_MESSAGE_THRESHOLD: THRESHOLD,
    COMPACT_KEEP_TAIL: KEEP,
    COMPACT_HYSTERESIS: HYSTERESIS,
    assertCompactPolicyInvariants,
    isDigestMessage,
    maybeCompactSession,
    collapseStackedDigests,
} = compactMod;

// --- 真实导出常量 + 真实不变量断言（阈值一改即红）---
assert.strictEqual(THRESHOLD, 96, 'COMPACT_MESSAGE_THRESHOLD');
assert.strictEqual(KEEP, 48, 'COMPACT_KEEP_TAIL');
assert.strictEqual(HYSTERESIS, 16, 'COMPACT_HYSTERESIS');
assert.ok(KEEP + 1 + HYSTERESIS < THRESHOLD, 'invariant KEEP+1+HYSTERESIS < THRESHOLD');
assert.doesNotThrow(() => assertCompactPolicyInvariants());

// --- 接线：session.ts 必须复用 compact 的 collapseStackedDigests，不得自带阈值副本 ---
assert.ok(compactSrc.includes('export function collapseStackedDigests'));
assert.ok(sessionSrc.includes('collapseStackedDigests'));
assert.ok(sessionSrc.includes("from './smart-chat-compact'"));
assert.ok(!/COMPACT_MESSAGE_THRESHOLD\s*=\s*80/.test(sessionSrc));
assert.ok(!/COMPACT_KEEP_TAIL\s*=\s*100/.test(sessionSrc));

function mkPair(i, shut) {
  return [
    { role: 'user', content: `<host-state>\n沉默计数 ${i}\n</host-state>\n<batch-messages>\nmsg${i}\n</batch-messages>` },
    { role: 'assistant', content: shut ? '<shut_up/>' : `<replies>\n<msg>hi${i}</msg>\n</replies>` },
  ];
}

// --- 低于 THRESHOLD：不压 ---
{
  for (const n of [80, 90, 95]) {
    const messages = [];
    for (let i = 0; i < Math.floor(n / 2); i++) messages.push(...mkPair(i, true));
    while (messages.length < n) messages.push({ role: 'user', content: `pad${messages.length}` });
    messages.length = n;
    const session = { messages };
    maybeCompactSession(session);
    assert.strictEqual(session.messages.length, n, `len=${n} should not compact`);
    assert.strictEqual(session.messages.filter(isDigestMessage).length, 0);
  }
}

// --- 100：旧 bug 空 dropped；新策略仍 < 96? 100>=96 会压 ---
{
  const messages = [];
  for (let i = 0; i < 50; i++) messages.push(...mkPair(i, i % 3 === 0));
  assert.strictEqual(messages.length, 100);
  const session = { messages: [...messages], prefer_silence: true };
  maybeCompactSession(session);
  assert.ok(session.messages.length < THRESHOLD, `post-compact ${session.messages.length} < ${THRESHOLD}`);
  assert.strictEqual(session.messages.filter(isDigestMessage).length, 1);
  assert.ok(isDigestMessage(session.messages[0]));
  // 真实副作用：写 compacted_at、清 summary、降级粘性闭嘴
  assert.ok(typeof session.compacted_at === 'string' && session.compacted_at.length > 0);
  assert.ok(!('summary' in session));
  assert.strictEqual(session.prefer_silence, false, 'compact 后应降级 prefer_silence');
  // 真实尾部条数：KEEP 条（尾部无 digest 时）
  assert.strictEqual(session.messages.length, KEEP + 1);
}

// --- 101 / 200 ---
{
  for (const n of [101, 200]) {
    const messages = [];
    while (messages.length < n) {
      messages.push(...mkPair(messages.length, true));
    }
    messages.length = n;
    const session = { messages };
    maybeCompactSession(session);
    assert.ok(session.messages.length < THRESHOLD, `n=${n} post=${session.messages.length}`);
    assert.strictEqual(session.messages.filter(isDigestMessage).length, 1);
    assert.ok(isDigestMessage(session.messages[0]));
    // 尾部无残留 digest
    assert.ok(session.messages.slice(1).every((m) => !isDigestMessage(m)));
  }
}

// --- 尾部混入旧 digest：真实 keep-tail 过滤必须把它剔掉（原为源码文本代理断言）---
{
  const messages = [];
  while (messages.length < 200) messages.push(...mkPair(messages.length, true));
  messages.length = 200;
  const staleIdx = 200 - KEEP + 12; // 落在尾部保留窗口内
  messages[staleIdx] = {
    role: 'user',
    content: '<compaction-summary>\n[compact test]\n<digest-stance>\n- stale\n</digest-stance>\n</compaction-summary>',
  };
  const session = { messages };
  maybeCompactSession(session);
  assert.strictEqual(session.messages.filter(isDigestMessage).length, 1, '尾部旧 digest 应被过滤');
  assert.ok(isDigestMessage(session.messages[0]));
  assert.ok(session.messages.slice(1).every((m) => !isDigestMessage(m)));
  assert.strictEqual(session.messages.length, KEEP, '滤掉 1 条尾部 digest 后 = KEEP');
}

// --- 叠 7 条 digest → collapse 后 = 1 ---
{
  const digests = [];
  for (let i = 0; i < 7; i++) {
    digests.push({
      role: 'user',
      content: `<compaction-summary>\n[compact 2026-08-07T0${i}:00:00.000Z]\n说明：以下为远史压缩。\n<digest-stance>\n- （本段无明显约定/立场句）\n</digest-stance>\n<digest-assistants>\n后台把娱乐开关关了就不闹了。\n</digest-assistants>\n</compaction-summary>`,
    });
  }
  const live = [];
  for (let i = 0; i < 6; i++) live.push(...mkPair(i, false));
  const session = { messages: [...digests, ...live] };
  assert.strictEqual(session.messages.filter(isDigestMessage).length, 7);
  assert.ok(collapseStackedDigests(session));
  assert.strictEqual(session.messages.filter(isDigestMessage).length, 1);
  assert.ok(isDigestMessage(session.messages[0]));
  assert.ok(session.messages.slice(1).every((m) => !isDigestMessage(m)));
  assert.strictEqual(session.messages.length, live.length + 1);
  // 无叠放（单条且已在 index 0）→ 不动
  const clean = { messages: [digests[0], ...live] };
  const before = [...clean.messages];
  assert.strictEqual(collapseStackedDigests(clean), false);
  assert.deepStrictEqual(clean.messages, before);
}

console.log('verify-compact-policy: ok');
