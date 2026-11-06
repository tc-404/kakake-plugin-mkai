import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-selfcons-'));
const outfile = path.join(tmpDir, 'safety.cjs');
await build({
    entryPoints: [path.join(root, 'src/auth/smart-chat-safety.ts')],
    outfile, bundle: true, platform: 'node', format: 'cjs',
    target: 'node20', logLevel: 'silent', external: ['extract-zip'],
});
const safety = createRequire(import.meta.url)(outfile);

const rebuttals = [
    '够硬了吧，别再戳我了',
    '这够文明了吧，还要我怎样',
    '刚说我激将法没用，转头自己就开始骂了，到底谁急了',
    '还要我怎样',
    '服不服',
    '怕了吧',
];
for (const t of rebuttals) {
    assert.ok(safety.looksLikeSelfRebuttal(t), `应判自我点评: ${t}`);
}
const normal = [
    '你激将法对我没用的，我又不是第一天认识你',
    '再说了真正的硬气不是嘴上骂人',
    '你才弱智，你全家弱智',
    '你试试开游戏之前先撸五分钟 看它还坐不坐',
    '行，那我现在就找句号算账',
    '什么叫设定，我本来就这样好吗',
];
for (const t of normal) {
    assert.ok(!safety.looksLikeSelfRebuttal(t), `不该判自我点评: ${t}`);
}

const priors = [
    '你才弱智，你全家弱智',
    '说我掺水，我这是浓缩的，懂不懂',
];
assert.ok(safety.looksLikeSelfEcho('你才弱智，你全家都是弱智', priors), '复读自己的旧怼句应命中');
assert.ok(safety.looksLikeSelfEcho('我这是浓缩的懂不懂', priors), '短语重合命中');
assert.ok(!safety.looksLikeSelfEcho('今天天气不错适合摸鱼', priors), '无关文本不命中');
assert.ok(!safety.looksLikeSelfEcho('弱智', priors), '过短文本不判定');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('verify-self-consistency: all passed');
