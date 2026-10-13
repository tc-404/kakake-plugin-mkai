/**
 * 自定义人设融合预热：判定、闸门、失败丢弃 batch
 * 运行：npm run verify:persona-fusion
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 以下判定直接加载真实源码（原实现是本文件内联复刻 isStockPersonaLine /
// hashPersonaFusionKey / needsPersonaFusion / isPersonaFusionReady）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-persona-fusion-'));

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
const switchesMod = await loadModule('src/auth/smart-chat-switches.ts');

const { DEFAULT_PERSONA_LINE, SMART_CHAT_ROOT } = typesMod;
const {
    hashPersonaFusionKey,
    needsPersonaFusionForChat,
    isPersonaFusionReady,
} = switchesMod;

const SMART_CHAT_GROUP_PERSONA = `${SMART_CHAT_ROOT}人设群.json`;

/**
 * 假 deps：只在内存里应答「分群人设」文件，其余取默认值。
 * needsPersonaFusionForChat 只需要 readB（走 resolveEffectivePersonaLine → getSmartChatPersonaOverride）。
 * 这同时把「群独立人设覆盖全局默认」这条真实路径纳入了断言 —— 原来的内联副本只看单行文本。
 */
function makeDeps(groupPersonas = {}) {
    return {
        readB(file, key, def) {
            if (String(file) === SMART_CHAT_GROUP_PERSONA && Object.prototype.hasOwnProperty.call(groupPersonas, key)) {
                return groupPersonas[key];
            }
            return def;
        },
    };
}

const depsPlain = makeDeps();

// 默认人设不预热
assert.strictEqual(needsPersonaFusionForChat(depsPlain, 'g_900001', { system_prompt: DEFAULT_PERSONA_LINE }), false);
assert.strictEqual(needsPersonaFusionForChat(depsPlain, 'p_800001', { system_prompt: DEFAULT_PERSONA_LINE }), false);

// 空 / 纯空白人设 → 内存回落内置默认句 → 同样不预热
assert.strictEqual(needsPersonaFusionForChat(depsPlain, 'g_900001', { system_prompt: '' }), false);
assert.strictEqual(needsPersonaFusionForChat(depsPlain, 'g_900001', { system_prompt: '   ' }), false);

// 自定义人设需预热
const custom = '你是群里的测试猫娘，说话带喵。';
assert.strictEqual(needsPersonaFusionForChat(depsPlain, 'g_900001', { system_prompt: custom }), true);

// 群独立人设覆盖全局默认 → 该群仍需预热，别的群不受影响
const depsOverride = makeDeps({ '900001': custom });
assert.strictEqual(needsPersonaFusionForChat(depsOverride, 'g_900001', { system_prompt: DEFAULT_PERSONA_LINE }), true);
assert.strictEqual(needsPersonaFusionForChat(depsOverride, 'g_900002', { system_prompt: DEFAULT_PERSONA_LINE }), false);

// hash 稳定
const h1 = hashPersonaFusionKey(custom);
const h2 = hashPersonaFusionKey(custom);
assert.strictEqual(h1, h2);
assert.strictEqual(h1.length, 16);
assert.notStrictEqual(h1, hashPersonaFusionKey(DEFAULT_PERSONA_LINE));

// 人设变更需重新预热
assert.strictEqual(isPersonaFusionReady({ persona_fusion_hash: h1 }, h1), true);
const other = '你是另一个自定义人设。';
const hOther = hashPersonaFusionKey(other);
assert.notStrictEqual(h1, hOther);
assert.strictEqual(isPersonaFusionReady({ persona_fusion_hash: h1 }, hOther), false);
assert.strictEqual(isPersonaFusionReady({}, h1), false);
// personaHash 为空 = 没有要求 → 直接算就绪（真实契约；原内联副本在「会话有 hash 但传空」时会给出 false）
assert.strictEqual(isPersonaFusionReady({ persona_fusion_hash: h1 }, ''), true);

const switchesSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-switches.ts'), 'utf8');
assert.ok(switchesSrc.includes('needsPersonaFusionForChat'));
assert.ok(switchesSrc.includes('hashPersonaFusionKey'));
assert.ok(switchesSrc.includes('isPersonaFusionReady'));

const typesSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-types.ts'), 'utf8');
assert.ok(typesSrc.includes('persona_fusion_hash'));

const fusionSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-persona-fusion.ts'), 'utf8');
assert.ok(fusionSrc.includes('runPersonaFusionWarmup'));
assert.ok(fusionSrc.includes('PERSONA_FUSION_PROBE_USER'));
assert.ok(fusionSrc.includes('人设融合预热失败响应'));
assert.ok(fusionSrc.includes('raw: result.raw'));

const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
assert.ok(flushSrc.includes('人设融合预热开始'));
assert.ok(flushSrc.includes('人设融合预热失败'));
// 预热失败=上游坏了：这一批必须放回缓冲，不能再「本轮排队已丢弃」把用户消息吞掉
assert.ok(
    !flushSrc.includes('本轮排队已丢弃'),
    '预热失败不得丢批（应走 handleFlushFailure 放回缓冲）',
);
assert.ok(flushSrc.includes('handleFlushFailure'), '预热失败走统一失败收尾');
assert.ok(flushSrc.includes('runPersonaFusionWarmup'));

const sessionSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-session.ts'), 'utf8');
assert.ok(sessionSrc.includes('persona_fusion_hash'));

const composeSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compose.ts'), 'utf8');
assert.ok(composeSrc.includes('buildSessionSystemPrompt'));

console.log('verify-persona-fusion: ok');
