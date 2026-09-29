/**
 * Anthropic / OpenAI 双协议：buildChatUrl、模型列表解析、关键源码接线
 * 运行：npm run verify:model-protocol
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 以下逻辑直接加载真实源码（原实现是本文件内联复刻：改 URL 拼法/换解析分支都不会被发现）
// ---------------------------------------------------------------------------
import { build } from 'esbuild';

const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-model-proto-'));

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

const apiUrlMod = await loadModule('src/auth/smart-chat-api-url.ts');
const modelsMod = await loadModule('src/auth/smart-chat-models.ts');
const {
    ANTHROPIC_API_VERSION,
    buildChatUrl,
    normalizeApiProtocol,
    resolveApiProtocol,
    resolveEffectiveChatPath,
} = apiUrlMod;
const { fetchModelList } = modelsMod;

// buildChatUrl：空 path 仅用 base
assert.strictEqual(
  buildChatUrl('https://proxy.example/v1/chat/completions', ''),
  'https://proxy.example/v1/chat/completions',
);
assert.strictEqual(
  buildChatUrl('https://api.example.com/', '/v1/messages'),
  'https://api.example.com/v1/messages',
);
assert.strictEqual(
  buildChatUrl('https://api.example.com', 'v1/models'),
  'https://api.example.com/v1/models',
);

// 协议解析（真实 resolveApiProtocol / normalizeApiProtocol）
assert.strictEqual(normalizeApiProtocol('Anthropic'), 'anthropic');
assert.strictEqual(normalizeApiProtocol(''), 'openai');
assert.strictEqual(normalizeApiProtocol('openai-compatible'), 'openai');
assert.strictEqual(resolveApiProtocol({ vendor: '' }), 'openai');
// custom_* 前缀 + 已注册 + 声明 anthropic 才走 anthropic（isCustomVendorId 见 smart-chat-config.ts）
assert.strictEqual(
  resolveApiProtocol({ vendor: 'custom_c1', custom_vendors: [{ id: 'custom_c1', api_protocol: 'anthropic' }] }),
  'anthropic',
);
assert.strictEqual(resolveApiProtocol({ vendor: 'custom_gone', custom_vendors: [] }), 'openai', '未注册的 custom id 回落 openai');
assert.strictEqual(resolveApiProtocol({ vendor: 'deepseek' }), 'openai', '内置 vendor 一律 openai');
assert.strictEqual(resolveEffectiveChatPath('', 'anthropic'), '/v1/messages');
assert.strictEqual(resolveEffectiveChatPath('', 'openai'), '/v1/chat/completions');
assert.strictEqual(resolveEffectiveChatPath('/custom/x', 'openai'), '/custom/x');

// --- 模型列表：真实 fetchModelList（含私有 parseModelIds / /v1/models 拼法）---
const realFetch = globalThis.fetch;
const fetchCalls = [];
function withStubbedFetch(handler, fn) {
  const prev = globalThis.fetch;
  fetchCalls.length = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), headers: (init && init.headers) || {} });
    return handler(String(url));
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = prev;
    });
}
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
function lastCalls() {
  return fetchCalls.splice(0, fetchCalls.length);
}

// OpenAI 形态（data[]）
const openAiFixture = {
  data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
};
await withStubbedFetch(() => jsonResponse(openAiFixture), async () => {
  const r = await fetchModelList({ api_key: 'sk-test', base_url: 'https://api.example.com/' });
  assert.deepStrictEqual(r.models, ['gpt-4o', 'gpt-4o-mini']);
  assert.strictEqual(r.ok, true);
  const calls = lastCalls();
  assert.strictEqual(calls[0].url, 'https://api.example.com/v1/models');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer sk-test');
});

// NewAPI / OneAPI models[] 形态
const oneApiFixture = {
  models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
};
await withStubbedFetch(() => jsonResponse(oneApiFixture), async () => {
  const r = await fetchModelList({ api_key: 'sk-test', base_url: 'https://api.example.com' });
  assert.deepStrictEqual(r.models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.strictEqual(r.ok, true);
});

// Anthropic 形态（data[]，走 x-api-key + anthropic-version）
const anthropicFixture = {
  data: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-3-5-haiku-20241022' }],
};
await withStubbedFetch(() => jsonResponse(anthropicFixture), async () => {
  const r = await fetchModelList({
    api_key: 'ak-test',
    base_url: 'https://api.anthropic.com',
    api_protocol: 'anthropic',
  });
  assert.deepStrictEqual(r.models, ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022']);
  const calls = lastCalls();
  assert.strictEqual(calls[0].url, 'https://api.anthropic.com/v1/models');
  assert.strictEqual(calls[0].headers['x-api-key'], 'ak-test');
  assert.strictEqual(calls[0].headers['anthropic-version'], ANTHROPIC_API_VERSION);
  assert.strictEqual(calls[0].headers.Authorization, undefined, 'anthropic 不得带 Bearer');
});

// 去重 + 空 id 过滤 + 非对象行
await withStubbedFetch(
  () => jsonResponse({ data: [{ id: 'a' }, { id: 'a' }, { id: '  ' }, null, 'x', { id: ' b ' }] }),
  async () => {
    const r = await fetchModelList({ api_key: 'sk-test', base_url: 'https://api.example.com' });
    assert.deepStrictEqual(r.models, ['a', 'b']);
  },
);

// OpenAI 兼容路线先试 /v1/models，失败回退 /models
await withStubbedFetch(
  (url) => (url.endsWith('/v1/models') ? jsonResponse({ error: 'nope' }, 404) : jsonResponse({ data: [{ id: 'm1' }] })),
  async () => {
    const r = await fetchModelList({ api_key: 'sk-test', base_url: 'https://api.example.com' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['m1']);
    const calls = lastCalls();
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].url, 'https://api.example.com/v1/models');
    assert.strictEqual(calls[1].url, 'https://api.example.com/models');
  },
);

// 响应里没有模型 → ok:false
await withStubbedFetch(() => jsonResponse({ data: [] }), async () => {
  const r = await fetchModelList({ api_key: 'sk-test', base_url: 'https://api.example.com' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_models_in_response');
});

// 无 key / 无 base：不发请求
await withStubbedFetch(() => jsonResponse({ data: [{ id: 'x' }] }), async () => {
  assert.strictEqual((await fetchModelList({ api_key: '', base_url: 'https://api.example.com' })).error, 'api_key_not_configured');
  assert.strictEqual((await fetchModelList({ api_key: 'k', base_url: '' })).error, 'base_url_required');
  assert.strictEqual(fetchCalls.length, 0, '缺配置时不得发请求');
});
assert.strictEqual(globalThis.fetch, realFetch, 'fetch 桩必须还原');

// --- 源码接线契约（这些文件不加载，只确认调用点仍在）---
const modelsSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-models.ts'), 'utf8');
assert.ok(modelsSrc.includes('export async function fetchModelList'));

const providerSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-provider.ts'), 'utf8');
assert.ok(providerSrc.includes('chatCompletionAnthropic'));
assert.ok(providerSrc.includes('chatCompletionOpenAI'));
assert.ok(providerSrc.includes('resolveApiProtocol(config)'));

const webSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-web.ts'), 'utf8');
assert.ok(webSrc.includes("wrapPath('/smart-chat/models')"));

const billingSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-billing.ts'), 'utf8');
assert.ok(billingSrc.includes('testAnthropicMessages'));
assert.ok(billingSrc.includes("protocol === 'anthropic'"));

const configPage = fs.readFileSync(path.join(root, 'webui-src/pages/ConfigPage.tsx'), 'utf8');
assert.ok(configPage.includes('startAddCustomAnthropic'));
assert.ok(configPage.includes('protocolLabel'));
assert.ok(configPage.includes('mk-input-with-action'));
assert.ok(configPage.includes('fetchModelList'));

const controllerSrc = fs.readFileSync(path.join(root, 'webui-src/controllers/useConfigController.ts'), 'utf8');
assert.ok(controllerSrc.includes("startAddCustom('anthropic')") || controllerSrc.includes('startAddCustomAnthropic'));
assert.ok(controllerSrc.includes('api_protocol'));

const logicSrc = fs.readFileSync(path.join(root, 'webui-src/smartChatLogic.ts'), 'utf8');
assert.ok(logicSrc.includes('api_protocol'));
assert.ok(logicSrc.includes('apiProtocol'));

console.log('verify-model-protocol: ok');
