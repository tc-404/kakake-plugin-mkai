/**
 * 协议端媒体路径契约 —— 真跑源码
 *
 * 背景（2026-09-29 两轮实测）：
 *   第一轮：插件把本地路径用 pathToFileURL() 转成 file:// 塞进 record 段的 file，
 *           NapCat 报「语音转换失败, 请检查语音文件是否正常」。
 *   第二轮：改成裸绝对路径后，NapCat 改报
 *           「文件处理失败: 识别URL失败, uri= C:/Users/...」——
 *           因为它对 file 字段先做 URL 识别，`C:` 被当成 scheme。
 *
 * 两轮的共同结论：**NapCat 的 record 段不收本地路径**（file:// 不行，裸路径也不行），
 * 只认 http(s) URL / base64:// 。日志对照（02:26 同一轮）：
 *   https URL ✓ / file:// ✗ / 裸 C:/ ✗ —— 本地路径无一成功。
 *
 * 所以本地文件必须读成 base64:// 下发（NapCat 自己发本地附件也是这条路）。
 * 这个脚本锁死四条契约，防止以后再退化：
 *   1. 段_语音 / 段_图片：本地存在的文件 → base64:// 开头，绝不含裸盘符路径
 *   2. 远端 http(s) URL → 原样透传（不改写、不二次编码）
 *   3. base64:// 输入幂等（不得二次编码）
 *   4. 源码不得再 import pathToFileURL 去包装发出去的媒体
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-media-path-'));

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

const bot = await loadModule('src/lib/bot.ts');

// —— 1. 本地存在的文件 → base64://（NapCat 不收本地路径） ——
{
    const tmp = path.join(os.tmpdir(), `mkai-media-${Date.now()}.ogg`);
    const payload = Buffer.from('OggS0000-mkai-test-payload');
    fs.writeFileSync(tmp, payload);

    const rec = bot.段_语音(tmp);
    assert.strictEqual(rec.type, 'record', '语音段类型是 record');
    assert.ok(
        rec.data.file.startsWith('base64://'),
        `本地语音必须转 base64://，实得 ${rec.data.file.slice(0, 80)}`,
    );
    assert.ok(!/^file:\/\//i.test(rec.data.file), '本地语音不得输出 file://');
    assert.ok(!rec.data.file.includes('file://'), '本地语音路径不得含 file:// 子串');
    // 关键：绝不能把裸盘符路径漏下去（C: 会被 NapCat 当 URL scheme → 识别URL失败）
    assert.ok(!/^[A-Za-z]:[\\/]/.test(rec.data.file), '不得下发裸盘符路径（NapCat 报识别URL失败）');
    assert.ok(!rec.data.file.includes('\\'), 'base64 串里不得混入反斜杠');
    // 往返可还原
    const decoded = Buffer.from(rec.data.file.slice('base64://'.length), 'base64');
    assert.ok(decoded.equals(payload), 'base64 内容可无损还原');

    const img = bot.段_图片(tmp);
    assert.strictEqual(img.type, 'image', '图片段类型是 image');
    assert.ok(img.data.file.startsWith('base64://'), '本地图片同样必须转 base64://');

    // 相对路径也要能解析成本地文件并转 base64
    const prevCwd = process.cwd();
    try {
        process.chdir(os.tmpdir());
        const rel = bot.段_语音(path.basename(tmp));
        assert.ok(rel.data.file.startsWith('base64://'), '相对路径也要转 base64://');
    } finally {
        process.chdir(prevCwd);
    }

    fs.unlinkSync(tmp);
}

// —— 2. 远端 URL / base64 原样透传 ——
{
    const url = 'https://cdn.example.com/a/b/c.ogg?x=1&y=2';
    assert.strictEqual(bot.段_语音(url).data.file, url, 'http URL 原样透传');
    assert.strictEqual(bot.段_图片(url).data.file, url, 'http 图片 URL 原样透传');

    const b64 = 'base64://AAAA';
    assert.strictEqual(bot.段_语音(b64).data.file, b64, 'base64 原样透传（不得二次编码）');

    const data = 'data:audio/ogg;base64,AAAA';
    assert.strictEqual(bot.段_语音(data).data.file, data, 'data URI 原样透传');
}

// —— 3. 历史遗留 file:// 输入：剥路径后转 base64（幂等，且不二次编码） ——
{
    const tmp = path.join(os.tmpdir(), `mkai-media-legacy-${Date.now()}.silk`);
    const payload = Buffer.from('#!SILK_V3-legacy');
    fs.writeFileSync(tmp, payload);
    const asFileUrl = `file:///${tmp.replace(/\\/g, '/')}`;
    const rec = bot.段_语音(asFileUrl);
    assert.ok(!rec.data.file.includes('file://'), 'file:// 输入不得原样下发');
    assert.ok(rec.data.file.startsWith('base64://'), 'file:// 输入应剥成路径后转 base64');
    const decoded = Buffer.from(rec.data.file.slice('base64://'.length), 'base64');
    assert.ok(decoded.equals(payload), 'file:// 输入转出的 base64 应指向原文件内容');
    fs.unlinkSync(tmp);
}

// —— 4. 不存在的本地路径：不炸，且不留半截 base64 ——
{
    const missing = path.join(os.tmpdir(), `mkai-missing-${Date.now()}.ogg`);
    const rec = bot.段_语音(missing);
    assert.strictEqual(rec.type, 'record', '缺失文件仍产出 record 段（交协议端报错）');
    assert.ok(!rec.data.file.startsWith('base64://'), '读不到文件时不得产出空 base64');
}

// —— 5. 空值 / 非法值不炸 ——
{
    assert.strictEqual(bot.段_语音('').type, 'text', '空语音 → 文本兜底');
    assert.strictEqual(bot.段_图片('').type, 'text', '空图片 → 文本兜底');
    assert.doesNotThrow(() => bot.段_语音(null), 'null 不炸');
}

// —— 6. 源码级：媒体出口不得再引入 pathToFileURL；本地路径必须走 base64 ——
{
    const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    const botSrc = src('src/lib/bot.ts');
    assert.ok(!/import\s*\{[^}]*pathToFileURL[^}]*\}\s*from\s*'url'/.test(botSrc), 'bot.ts 不得 import pathToFileURL');
    assert.ok(/本地媒体转base64/.test(botSrc), 'bot.ts 应保留本地媒体转 base64 的实现');

    const voiceSrc = src('src/auth/smart-chat-voice.ts');
    assert.ok(!/import\s*\{[^}]*pathToFileURL[^}]*\}\s*from\s*'url'/.test(voiceSrc), 'voice.ts 不得 import pathToFileURL');
    assert.ok(!/return\s+pathToFileURL\(/.test(voiceSrc), 'voice.ts 不得返回 pathToFileURL(...)');

    const fileSrc = src('src/auth/smart-chat-file.ts');
    assert.ok(!/import\s*\{[^}]*pathToFileURL[^}]*\}\s*from\s*'url'/.test(fileSrc), 'file.ts 不得 import pathToFileURL');
    assert.ok(!/pathToFileURL\(/.test(fileSrc), 'file.ts 不得调用 pathToFileURL');

    // 构建产物里也不能残留文件协议包装
    const bundle = path.join(root, 'kakake-plugin-mkai', 'index.mjs');
    if (fs.existsSync(bundle)) {
        const dist = fs.readFileSync(bundle, 'utf8');
        assert.ok(!/pathToFileURL/.test(dist), '产物 index.mjs 不得残留 pathToFileURL');
    }
}

removeTmpDir(tmpDir);
console.log('verify-media-path: all passed');
