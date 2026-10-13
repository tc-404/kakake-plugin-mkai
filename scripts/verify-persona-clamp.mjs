/**
 * 【你是谁】：1200 字上限；默认人设不落盘（空/库存 → 内存 DEFAULT，写出删键）
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 以下逻辑直接加载真实源码（原实现是本文件内联复刻 clampPersonaText /
// extractPersonaLine / canonicalizePersonaLine / isStockPersonaLine /
// normalizeStoredPersonaPrompt / resolvePersonaLineForMemory / configObjectForDisk，
// 改 src 里的阈值或分支本文件也照样绿）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-persona-clamp-'));

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
const configMod = await loadModule('src/auth/smart-chat-config.ts');

const {
    DEFAULT_PERSONA_LINE,
    DEFAULT_SYSTEM_PROMPT,
    LEGACY_SYSTEM_PROMPTS,
    PERSONA_MAX_CHARS,
    clampPersonaText,
    extractPersonaLine,
    looksLikeFullSystemPrompt,
} = typesMod;
const {
    isStockPersonaLine,
    normalizeStoredPersonaPrompt,
    resolvePersonaLineForMemory,
    configObjectForDisk,
} = configMod;

/**
 * Web 保存路径的磁盘语义。
 * 真正的 Web 入口 smart-chat-web.ts:345 toStoredSystemPrompt 未导出（无运行时接缝），
 * 这里用同一份导出的磁盘语义 smart-chat-config.ts:74 normalizeStoredPersonaPrompt
 * （截断 + 昵称槽归一 + 等于默认存空串）。
 * 已知覆盖缺口：Web 侧独有的「群友/老成员/熟人 <昵称> → {{BOT_NICK}}」替换段
 * 与 resolvedDefault/resolvedFallback 判等只在源码接线断言里守着，没有被真跑。
 */
const toStored = normalizeStoredPersonaPrompt;

/** configObjectForDisk 真实签名是 (SmartChatConfig)，原内联副本签名是 (system_prompt) */
function configObjectForPersona(systemPrompt) {
    return configObjectForDisk({ system_prompt: systemPrompt, model: 'x' });
}

// —— 截断契约（自定义仍保留）——
{
  const custom = '自定义人设：' + '哈'.repeat(490);
  assert.ok(custom.length > 420 && custom.length < 1200);
  assert.ok(!looksLikeFullSystemPrompt(custom));
  const stored = toStored(custom);
  assert.strictEqual(stored, custom);
  assert.notStrictEqual(stored, DEFAULT_PERSONA_LINE);
  assert.strictEqual(normalizeStoredPersonaPrompt(custom), custom);
}

{
  const custom = '丙'.repeat(900);
  assert.strictEqual(toStored(custom).length, 900);
}

{
  const custom = '甲'.repeat(1200);
  assert.strictEqual(toStored(custom).length, 1200);
}

{
  const custom = '乙'.repeat(1300);
  const stored = toStored(custom);
  assert.strictEqual(stored.length, 1200);
  assert.strictEqual(stored, '乙'.repeat(1200));
}

{
  const multi = '第一行性格\n第二行口癖\n第三行禁忌';
  assert.strictEqual(toStored(multi), multi);
}

{
  const full =
    '【你是谁】\n' +
    '你是群里的「猫」：爱摸鱼。\n' +
    '【怎么说话】\n' +
    '短一点。\n';
  assert.ok(looksLikeFullSystemPrompt(full));
  const stored = toStored(full);
  assert.ok(stored.includes('爱摸鱼'));
  assert.ok(!stored.includes('【怎么说话】'));
}

// —— 默认不落盘 ——
{
  assert.strictEqual(normalizeStoredPersonaPrompt(''), '');
  assert.strictEqual(normalizeStoredPersonaPrompt(DEFAULT_PERSONA_LINE), '');
  assert.strictEqual(resolvePersonaLineForMemory(''), DEFAULT_PERSONA_LINE);
  assert.strictEqual(resolvePersonaLineForMemory(undefined), DEFAULT_PERSONA_LINE);
  assert.strictEqual(resolvePersonaLineForMemory(DEFAULT_PERSONA_LINE), DEFAULT_PERSONA_LINE);
  assert.strictEqual(toStored(DEFAULT_PERSONA_LINE), '');
  assert.strictEqual(toStored(''), '');

  const diskOmit = configObjectForPersona(DEFAULT_PERSONA_LINE);
  assert.ok(!Object.prototype.hasOwnProperty.call(diskOmit, 'system_prompt'));

  const diskOmitEmpty = configObjectForPersona('');
  assert.ok(!Object.prototype.hasOwnProperty.call(diskOmitEmpty, 'system_prompt'));

  const custom = '自定义损友：只抬杠不捧场';
  const diskKeep = configObjectForPersona(custom);
  assert.strictEqual(diskKeep.system_prompt, custom);

  // 无键 / "" → 同一内存有效句 → 同一指纹绑定字段
  const memA = resolvePersonaLineForMemory('');
  const memB = resolvePersonaLineForMemory(DEFAULT_PERSONA_LINE);
  assert.strictEqual(memA, memB);
  assert.strictEqual(memA, DEFAULT_PERSONA_LINE);
}

// 旧盘默认全文 → 抽句后为库存 → 磁盘删键
{
  const fullDefaultish =
    '【你是谁】\n' +
    DEFAULT_PERSONA_LINE +
    '\n【怎么说话】\n短一点。\n';
  assert.strictEqual(normalizeStoredPersonaPrompt(fullDefaultish), '');
  assert.ok(!Object.prototype.hasOwnProperty.call(configObjectForPersona(fullDefaultish), 'system_prompt'));
}

// 截断契约的真实常量（原为 /PERSONA_MAX_CHARS\s*=\s*1200/ 源码文本代理）
assert.strictEqual(PERSONA_MAX_CHARS, 1200, 'PERSONA_MAX_CHARS 必须是 1200');
assert.strictEqual(clampPersonaText('丁'.repeat(1300)).length, PERSONA_MAX_CHARS);
assert.strictEqual(clampPersonaText('  '), '');
assert.strictEqual(extractPersonaLine(''), DEFAULT_PERSONA_LINE);
assert.strictEqual(isStockPersonaLine(''), true);
assert.strictEqual(isStockPersonaLine('自定义损友：只抬杠不捧场'), false);

// 库存判定的其余真分支（原内联副本没有 LEGACY 这一支）
assert.ok(LEGACY_SYSTEM_PROMPTS.length > 0, 'LEGACY 稿清单非空');
assert.strictEqual(isStockPersonaLine(LEGACY_SYSTEM_PROMPTS[0]), true, 'LEGACY 稿算库存');
assert.strictEqual(normalizeStoredPersonaPrompt(LEGACY_SYSTEM_PROMPTS[0]), '', 'LEGACY 稿不落盘');
assert.ok(
    !Object.prototype.hasOwnProperty.call(configObjectForPersona(LEGACY_SYSTEM_PROMPTS[0]), 'system_prompt'),
    'LEGACY 稿写出时不带 system_prompt 键',
);

// 源码接线契约（守「谁定义 / 谁调用」，行为已由上面的真函数覆盖）
{
  const types = fs.readFileSync(path.join(root, 'src/auth/smart-chat-types.ts'), 'utf8');
  assert.ok(types.includes('clampPersonaText'));
  assert.ok(types.includes('磁盘 config.json 可选') || types.includes('缺省/空 = 跟随'));
  assert.ok(!/p\.length\s*>\s*420/.test(types));

  const cfg = fs.readFileSync(path.join(root, 'src/auth/smart-chat-config.ts'), 'utf8');
  assert.ok(cfg.includes('isStockPersonaLine'));
  assert.ok(cfg.includes('configObjectForDisk'));
  assert.ok(cfg.includes('resolvePersonaLineForMemory'));
  assert.ok(cfg.includes('delete out.system_prompt'));

  const web = fs.readFileSync(path.join(root, 'src/auth/smart-chat-web.ts'), 'utf8');
  assert.ok(web.includes('clampPersonaText'));
  assert.ok(/return ''/.test(web) || web.includes("return '';"));
  assert.ok(web.includes('等于默认时存空串') || web.includes("return '';"));

  const logic = fs.readFileSync(path.join(root, 'webui-src/smartChatLogic.ts'), 'utf8');
  assert.ok(logic.includes('defaultSystemPrompt'));
  assert.ok(logic.includes("stock && prompt === stock ? ''"));

  const page = fs.readFileSync(path.join(root, 'webui-src/pages/ConfigPage.tsx'), 'utf8');
  assert.ok(page.includes('最多 1200 字'));
  assert.ok(page.includes('maxLength={1200}'));
  // 默认人设回填已从页面下沉到控制器
  const ctrl = fs.readFileSync(path.join(root, 'webui-src/controllers/useConfigController.ts'), 'utf8');
  assert.ok(ctrl.includes('defaultSystemPrompt: defaultPrompt'));

  const fp = fs.readFileSync(path.join(root, 'src/auth/smart-chat-fingerprint.ts'), 'utf8');
  assert.ok(fp.includes('system_prompt'));
}

// ---------------------------------------------------------------------------
// 已知 src 缺陷（未修，故意留红；断言不放宽、不删除）—— 由本次「改用真实源码」暴露
//
// 断言：isStockPersonaLine(DEFAULT_SYSTEM_PROMPT) 应为 true（整段现行默认 = 库存，不落盘）。
// 实测：false。同源证据（同一 bundle 内测，非跨 bundle 假象）：
//   isStockPersonaLine(DEFAULT_SYSTEM_PROMPT)                 -> false   （期望 true）
//   isStockPersonaLine(DEFAULT_SYSTEM_PROMPT.trim())          -> false   （同样期望 true）
//   normalizeStoredPersonaPrompt(DEFAULT_SYSTEM_PROMPT)       -> 1200 字整段稿（期望 ''）
//   configObjectForDisk({system_prompt: DEFAULT_SYSTEM_PROMPT}) -> 仍保留 system_prompt 键（期望省略）
//   resolvePersonaLineForMemory(DEFAULT_SYSTEM_PROMPT)        -> 不等于 DEFAULT_PERSONA_LINE
//
// 根因（smart-chat-config.ts）：
//   :58  `const p = String(prompt || '').trim();`
//   :61  `if (p === DEFAULT_SYSTEM_PROMPT) return true;`  ← 拿 trim 后的串与**未 trim** 的常量比。
//        DEFAULT_SYSTEM_PROMPT 由 assembleSystemPromptBase() 拼出，末尾带 '\n'（实测 length=1215 且 endsWith('\n')），
//        trim 后永不相等 → 这一支不可达（:33 的 isUpgradableStockPresencePrompt 里同样写法同样不可达）。
//   兜底也拦不住：DEFAULT_SYSTEM_PROMPT 里没有【身份怎么用】/【怎么说话】/【在场】/【脾气与欲望】四个整段稿标记
//        → looksLikeFullSystemPrompt() 为 false，走到 :67 得到非空 canonicalize → 判成「自定义」。
//   影响：旧盘里存着整段现行默认全文时，会被当成自定义人设写回（且被 PERSONA_MAX_CHARS 截成 1200 字），
//        有效人设与指纹绑定随之改变 —— 与 :52-56 注释「旧整段默认…算库存」及 :35「含已『最新』的完整稿」的意图相反。
// 判断：src 错（分支存在且注释声明该契约，只是比较写错），不是断言错。
// 建议修法（src 侧一行）：:61 改为 `if (p === DEFAULT_SYSTEM_PROMPT.trim()) return true;`（:33 同理）。
// ---------------------------------------------------------------------------
assert.strictEqual(
  isStockPersonaLine(DEFAULT_SYSTEM_PROMPT),
  true,
  '整段现行默认（DEFAULT_SYSTEM_PROMPT）应算库存 → 实测 false：会被当成自定义人设落盘（见上方注释）',
);

// 上面这条修好后才会走到这里（修法见注释：config.ts:61 用 trim 后的常量比较）
console.log('verify-persona-clamp: all passed');
