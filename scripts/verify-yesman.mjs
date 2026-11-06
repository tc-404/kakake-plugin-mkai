import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-yesman-'));
async function loadModule(relTsPath) {
    const outfile = path.join(tmpDir, `${path.basename(relTsPath, '.ts')}.cjs`);
    await build({
        entryPoints: [path.join(root, relTsPath)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        logLevel: 'silent',
        external: ['extract-zip'],
    });
    return createRequire(import.meta.url)(outfile);
}

const safety = await loadModule('src/auth/smart-chat-safety.ts');

const yes = [
    '对吧', '是的', '对啊', '确实', '没错', '嗯呐', '嗯', '可不是嘛', '就是啊',
    '对对对', '同感', '+1', '同意', '是吧', '好耶', '确实。', '是的！', '没错~',
    '  确实  ', '嗯呐嗯呐', 'OK', '对对对对对',
];
for (const t of yes) {
    assert.ok(safety.looksLikeYesManText(t), `应判为附和: ${JSON.stringify(t)}`);
}

const no = [
    '确实挺好玩的', '对吧，我觉得这版更新拉了', '是的呢，但是我有个疑问：这合理吗',
    '确实是有点问题？', '没错，就是那个卖假货的店', '同意楼上的说法，但价格虚高',
    '我看未必', '我觉得不行', '今天天气确实不错，适合摸鱼', '',
    '这个新版本把表情包功能砍了，确实可惜', '呵呵', '哈哈哈哈哈哈',
];
for (const t of no) {
    assert.ok(!safety.looksLikeYesManText(t), `不该判为附和: ${JSON.stringify(t)}`);
}

const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
assert.ok(flushSrc.includes('looksLikeYesManText'), 'flush 接入应声虫检测');
assert.ok(flushSrc.includes('禁止纯附和短句'), '强制开口 rescue 带主见要求');

const composeSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-compose.ts'), 'utf8');
assert.ok(composeSrc.includes('【有主见 · 最高优先】'), 'system 有主见规则');
assert.ok(composeSrc.includes('纯点头短句一条都不许发'), 'system 禁纯附和');
assert.ok(composeSrc.includes('禁止骑墙'), 'system 禁骑墙');
assert.ok(composeSrc.includes('别按对方写的剧本演'), 'system 有激将识别');
assert.ok(!/一两拍|三四拍|连两拍/.test(composeSrc + fs.readFileSync(path.join(root, 'src/auth/smart-chat-types.ts'), 'utf8')), 'system 无数量规格残留');

const pack = JSON.parse(fs.readFileSync(path.join(root, 'src/auth/style-packs/groupie.json'), 'utf8'));
const sits = new Set(pack.examples.map((e) => e.situation));
for (const s of ['有人抛观点', '有人说错', '让你站队', '两个人吵起来', '附和']) {
    assert.ok(sits.has(s), `风格包缺场景: ${s}`);
}
const fuhe = pack.examples.find((e) => e.situation === '附和');
assert.ok(/自己的信息|态度|抬杠/.test(fuhe.say), '附和场景要求带内容');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('verify-yesman: all passed');
