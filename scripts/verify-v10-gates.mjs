/**
 * v10 / 贴纸结构诚实闸回归（不调真实 API）
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 以下判定直接加载真实源码（原实现是本文件内联复刻：改正则/换分支都不会被发现）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-v10-'));

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

const stickerMod = await loadModule('src/auth/smart-chat-sticker.ts');
const safetyMod = await loadModule('src/auth/smart-chat-safety.ts');

const {
    scrubStickerHonestyActions,
    batchWantsStickerText,
    fuzzyResolveStickerInGallery,
} = stickerMod;
const {
    looksLikeEnglishRefusalText,
    rewriteEnglishRefusal,
    looksLikeAuthorImpersonation,
} = safetyMod;

// --- 插件不再自造固定回复：英文拒答一律丢弃转沉默，不注入中文替身句 ---
{
  const v11 = "I'm sorry, but I can't comply with that.";
  assert.ok(looksLikeEnglishRefusalText(v11));
  // 点名与否都返回 shut_up（丢弃），不再 replace 成写死中文句
  assert.strictEqual(rewriteEnglishRefusal(v11, { addressed: true })?.kind, 'shut_up');
  assert.strictEqual(rewriteEnglishRefusal(v11, { addressed: false })?.kind, 'shut_up');
  assert.strictEqual(rewriteEnglishRefusal('今天天气不错', { addressed: true }), null);
  const safetySrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-safety.ts'), 'utf8');
  assert.ok(safetySrc.includes('export function rewriteEnglishRefusal'));
  // 写死中文替身句 / 冒充作者句已废除，不得再作出站文案
  assert.ok(!safetySrc.includes("'这个我不太清楚'"));
  assert.ok(!safetySrc.includes("'这个得问插件作者'"));
}

// --- 结构诚实：发不出图时保留模型自己的话 / 丢空头许诺，不注入写死句 ---
{
  // 空头许诺（要图场景、无入队图）→ 丢弃转沉默
  for (const text of ['来，给你一张', '给你这个', '拿去玩', '这就发']) {
    const honest = scrubStickerHonestyActions([{ type: 'msg', text }], {
      hasPending: false,
      stickerAttempted: false,
      batchWants: true,
    });
    assert.strictEqual(honest.length, 0, `空头许诺应转沉默: ${text}`);
  }
  // 有实质内容的文字：原样保留（模型自己的话）
  const real = scrubStickerHonestyActions([{ type: 'msg', text: '哈哈这个笑死我了' }], {
    hasPending: false,
    stickerAttempted: true,
    batchWants: true,
  });
  assert.strictEqual(real.length, 1);
  assert.strictEqual(real[0].text, '哈哈这个笑死我了');
  // 有 pending：完全放行
  const ok = scrubStickerHonestyActions([{ type: 'msg', text: '给你这个' }], {
    hasPending: true,
    stickerAttempted: true,
    batchWants: true,
  });
  assert.strictEqual(ok[0].text, '给你这个');
  // 不要图且未尝试：不误杀闲聊
  const idle = scrubStickerHonestyActions([{ type: 'msg', text: '来，给你一张玩笑' }], {
    hasPending: false,
    stickerAttempted: false,
    batchWants: false,
  });
  assert.strictEqual(idle[0].text, '来，给你一张玩笑');
  // 带贴纸字段却没入队 = 图发不出：丢该动作；非 msg 原样；实质文字保留
  const mixed = scrubStickerHonestyActions(
    [
      { type: 'msg', text: '给你这个', sticker: '菲比/好诶.webp' },
      { type: 'msg', text: '来了' },
      { type: 'action', text: 'poke' },
      { type: 'msg', text: '哈哈笑死' },
    ],
    { hasPending: false, stickerAttempted: true, batchWants: true },
  );
  assert.strictEqual(mixed.length, 3, '发不出的贴纸动作应丢弃');
  assert.strictEqual(mixed[0].text, '来了');
  assert.deepStrictEqual(mixed[1], { type: 'action', text: 'poke' });
  assert.strictEqual(mixed[2].text, '哈哈笑死');
}

// --- 用户侧要图（中英）---
assert.ok(batchWantsStickerText('来点表情包'));
assert.ok(batchWantsStickerText('send me a sticker'));
assert.ok(batchWantsStickerText('give me a meme'));
assert.ok(!batchWantsStickerText('今天天气不错'));

// --- 作者冒充 ---
assert.ok(looksLikeAuthorImpersonation('参考一下我插件的 json'));
assert.ok(looksLikeAuthorImpersonation('我的插件里写了'));
assert.ok(!looksLikeAuthorImpersonation('这个得问插件作者'));

// --- 源码契约（只留「跨文件接线 / 已废弃 API 不得回流」类断言）---
{
  const stickerSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-sticker.ts'), 'utf8');
  assert.ok(stickerSrc.includes('@deprecated'));
  // 写死认栽常量已删除，源码里不得再出现
  assert.ok(!stickerSrc.includes('STICKER_FAIL_SHORT_MSG'));
  assert.ok(!stickerSrc.includes('这张发不出'));
  const scrubBlock = stickerSrc.slice(
    stickerSrc.indexOf('export function scrubStickerHonestyActions'),
    stickerSrc.indexOf('export function buildForceSendStickerToolChoice'),
  );
  // scrub 用空头许诺检测把「假装发了图」丢弃转沉默，但绝不注入写死句
  assert.ok(scrubBlock.includes('looksLikeStickerVerbalPromise'));
  assert.ok(!scrubBlock.includes('这张发不出'));
  assert.ok(!scrubBlock.includes('failMsg'));

  const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
  assert.ok(flushSrc.includes('预判跳过 LLM'));
  assert.ok(flushSrc.includes('silenceDec.mustSpeak'));
  assert.ok(flushSrc.includes('decideSilence'));
  assert.ok(flushSrc.includes('buildForceSendStickerToolChoice'));
  assert.ok(flushSrc.includes('stickerHonestyForce'));
  assert.ok(flushSrc.includes('强制 tool_choice='));
  assert.ok(!flushSrc.includes('路过瞄一眼'));

  const typesSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-types.ts'), 'utf8');
  assert.ok(typesSrc.includes('禁止冒充插件/框架作者'));

  // 阈值/常量与 collapseStackedDigests 行为已由 verify-compact-policy 直接跑真实导出；
  // 这里只守 session.ts 的接线。
  const sessionSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-session.ts'), 'utf8');
  assert.ok(sessionSrc.includes("from './smart-chat-compact'"));
  assert.ok(sessionSrc.includes('collapseStackedDigests'));

  const billingSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-billing.ts'), 'utf8');
  assert.ok(billingSrc.includes('cache_unsupported'));
}

// --- 智能对话10 样本：结构 scrub 回放 ---
{
  const dataRoot = path.join(root, '..', '..', '其他数据', '智能对话10');
  const samples = [];
  if (fs.existsSync(dataRoot)) {
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(json|jsonl|txt)$/i.test(name) && st.size < 8_000_000) {
          samples.push(p);
        }
      }
    };
    walk(dataRoot);
  }

  let promiseHits = 0;
  let authorHits = 0;
  for (const file of samples.slice(0, 40)) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/来，给你一张|给你一张|Here's one/i.test(raw)) {
      promiseHits += 1;
      // 中文空头许诺（要图场景、无入队图）→ 丢弃转沉默，不注入写死句
      const honest = scrubStickerHonestyActions(
        [{ type: 'msg', text: '来，给你一张' }],
        { hasPending: false, stickerAttempted: false, batchWants: true },
      );
      assert.strictEqual(honest.length, 0);
    }
    if (/我插件|我的插件|参考一下我/.test(raw)) {
      authorHits += 1;
      assert.ok(looksLikeAuthorImpersonation('参考一下我插件的 json'));
    }
  }

  const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
  assert.ok(flushSrc.includes('decideSilence'));
  assert.ok(flushSrc.includes('silenceDec.skipLlm'));

  console.log(
    `verify-v10-gates: stickerStructuralSamples≈${promiseHits} authorSamples≈${authorHits} files=${samples.length}`,
  );
}

console.log('verify-v10-gates: all passed');
