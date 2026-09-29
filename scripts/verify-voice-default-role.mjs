/**
 * 校验第三方配音「默认角色」契约。
 *
 * 需求：第三方配音（pearapi）默认使用「病娇少女」；配置为空时采用它。
 *
 * 为什么不能只做文本断言：这条需求的关键在于「哪些输入算空」以及
 * 「绝不能覆盖用户自己选的角色」。字符串匹配看不出这些分支对不对，
 * 所以这里真跑 `normalizeSmartChatConfig` / `defaultSmartChatConfig`。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const EXPECTED = '病娇少女';
const results = [];
const check = (name, fn) => {
  try {
    const out = fn();
    results.push({ ok: out === true || out === undefined, name, detail: out === true || out === undefined ? '' : String(out) });
  } catch (e) {
    results.push({ ok: false, name, detail: e?.message || String(e) });
  }
};

// ---------------------------------------------------------------------------
// 源码契约
// ---------------------------------------------------------------------------
const cfgSrc = read('src/auth/smart-chat-config.ts');
const voiceSrc = read('src/auth/smart-chat-voice.ts');
const pageSrc = read('webui-src/pages/VoicePage.tsx');

check('S1 宿主导出 DEFAULT_VOICE_DUB 常量且值为「病娇少女」', () => {
  if (!new RegExp(`export const DEFAULT_VOICE_DUB = '${EXPECTED}';`).test(cfgSrc)) {
    return '未找到 DEFAULT_VOICE_DUB 定义（或值不是「病娇少女」）';
  }
  return true;
});

check('S2 defaultVoiceSettings 用该常量作为 dub 默认值', () => {
  const fn = cfgSrc.match(/export function defaultVoiceSettings\(\)[\s\S]*?\n\}/);
  if (!fn) return '未找到 defaultVoiceSettings';
  if (!/dub:\s*DEFAULT_VOICE_DUB/.test(fn[0])) return 'dub 未取默认常量（仍是空串？）';
  return true;
});

check('S3 normalizeVoiceSettings 对空 dub 兜底（老配置升级也能生效）', () => {
  const fn = cfgSrc.match(/function normalizeVoiceSettings\(raw: unknown\)[\s\S]*?\n\}/);
  if (!fn) return '未找到 normalizeVoiceSettings';
  // 必须有「去掉空白后为空 → 取默认」的表达式
  if (!/dubRaw\s*\|\|\s*DEFAULT_VOICE_DUB/.test(fn[0])) {
    return '未对空 dub 兜底；只改 defaultVoiceSettings 的话老用户升级后仍是空角色';
  }
  return true;
});

check('S4 合成层不再因空角色直接失败（保留最后兜底）', () => {
  if (/if \(!dub\) return \{ ok: false, error: 'no_role_selected' \};/.test(voiceSrc)) {
    return '仍保留 no_role_selected 提前返回，空配置会静默失败';
  }
  if (!/const dub = String\(cfg\?\.voice\?\.dub \|\| ''\)\.trim\(\) \|\| DEFAULT_VOICE_DUB;/.test(voiceSrc)) {
    return '合成层未兜底到 DEFAULT_VOICE_DUB';
  }
  return true;
});

check('S5 前端展示的默认角色与宿主一致（避免两处漂移）', () => {
  if (!new RegExp(`const DEFAULT_VOICE_DUB = '${EXPECTED}';`).test(pageSrc)) {
    return 'VoicePage 未声明同名常量';
  }
  return true;
});

check('S6 pearapi 分支不再出现「留空只会按文本发送」的过时说明', () => {
  // 注意作用域：QQAI 分支确实没有默认角色，那句提示是对的，不能误删。
  // 这里只检查 pearapi（第三方配音）分支 —— 用「配音角色」标签切出该段。
  const segStart = pageSrc.indexOf('配音角色');
  const segEnd = pageSrc.indexOf('音频格式', segStart);
  if (segStart < 0 || segEnd < 0) return '未能定位 pearapi 的配音角色区块';
  const segment = pageSrc.slice(segStart, segEnd);
  if (/按文本发送/.test(segment)) {
    return 'pearapi 分支仍写着「只会按文本发送」（现在留空会用默认角色）';
  }
  if (!/留空则默认使用/.test(segment)) {
    return 'pearapi 分支未说明「留空则用默认角色」';
  }
  return true;
});

check('S7 前端提供一键填入默认角色的入口', () => {
  if (!/setDub\(DEFAULT_VOICE_DUB\)/.test(pageSrc)) return '未找到一键填入按钮';
  return true;
});

// ---------------------------------------------------------------------------
// 真跑：默认值落到实际配置对象上
// ---------------------------------------------------------------------------
const esbuild = await import('esbuild');
const built = await esbuild.build({
  entryPoints: [path.join(root, 'src/auth/smart-chat-config.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
});
const tmp = path.join(root, 'node_modules', '.tmp-voice-dub-verify.cjs');
fs.writeFileSync(tmp, built.outputFiles[0].text);
const m = createRequire(import.meta.url)(tmp);

/** 各类「空配置」都应落到默认角色 */
const EMPTY_CASES = [
  ['全新默认配置', () => m.defaultSmartChatConfig()],
  ['voice 缺失', () => m.normalizeSmartChatConfig({})],
  ['voice 为空对象', () => m.normalizeSmartChatConfig({ voice: {} })],
  ['dub 空串', () => m.normalizeSmartChatConfig({ voice: { dub: '' } })],
  ['dub 纯空白', () => m.normalizeSmartChatConfig({ voice: { dub: '   ' } })],
  ['dub 为 null', () => m.normalizeSmartChatConfig({ voice: { dub: null } })],
  ['dub 为 undefined', () => m.normalizeSmartChatConfig({ voice: { dub: undefined } })],
];

for (const [label, make] of EMPTY_CASES) {
  check(`R 空配置「${label}」→ dub=${EXPECTED}`, () => {
    const cfg = make();
    const dub = cfg?.voice?.dub;
    if (dub !== EXPECTED) return `实际 dub=${JSON.stringify(dub)}`;
    return true;
  });
}

/** 用户自己的选择绝不能被覆盖 —— 这是本需求最容易改错的地方 */
const KEEP_CASES = [
  ['自选角色', '文静学姐', '文静学姐'],
  ['自选含首尾空格', '  熊二  ', '熊二'],
  ['自选恰好等于默认值', EXPECTED, EXPECTED],
];

for (const [label, input, expect] of KEEP_CASES) {
  check(`R 用户${label}「${input}」不被覆盖`, () => {
    const cfg = m.normalizeSmartChatConfig({ voice: { dub: input } });
    if (cfg.voice.dub !== expect) return `实际 ${JSON.stringify(cfg.voice.dub)}，期望 ${JSON.stringify(expect)}`;
    return true;
  });
}

check('R QQAI 引擎配置不受影响（character 独立保留）', () => {
  const cfg = m.normalizeSmartChatConfig({ voice: { engine: 'qqai', qq_character: 'abc123' } });
  if (cfg.voice.engine !== 'qqai') return `engine 被改成 ${cfg.voice.engine}`;
  if (cfg.voice.qq_character !== 'abc123') return `qq_character 丢失：${cfg.voice.qq_character}`;
  return true;
});

check('R 默认引擎仍是 pearapi（默认角色只在第三方配音下有意义）', () => {
  const cfg = m.normalizeSmartChatConfig({ voice: {} });
  if (cfg.voice.engine !== 'pearapi') return `实际 ${cfg.voice.engine}`;
  return true;
});

check('R 默认角色不夹带首尾空白（可直接作为 dub 参数）', () => {
  const cfg = m.normalizeSmartChatConfig({ voice: {} });
  if (cfg.voice.dub !== cfg.voice.dub.trim()) return '默认值含空白';
  if (!cfg.voice.dub.length) return '默认值为空';
  return true;
});

try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('');
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : `\n      → ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length) {
  console.log(`[verify-voice-default-role] ${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`);
  process.exit(1);
}
console.log(`[verify-voice-default-role] ${results.length}/${results.length} 全部通过`);
