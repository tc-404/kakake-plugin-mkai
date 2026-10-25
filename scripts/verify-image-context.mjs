/**
 * B2/B4 图片上下文瘦身回归：
 * - dropFailedEyesLines：把「加载不出来/加载超时」的眼睛行整条删掉。
 * - presentImageSupplementsForModel(..., {dropFailed}): 历史/压缩路径丢失败图、压短正文；
 *   当轮路径（不传 dropFailed）保留占位。
 * 不调真实 API。
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const nmDir = path.join(root, 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-img-'));

const outfile = path.join(tmpDir, 'image.mjs');
await build({
    entryPoints: [path.join(root, 'src/auth/smart-chat-image.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    external: ['extract-zip'],
});
const { dropFailedEyesLines, presentImageSupplementsForModel } = await import(
    `file://${outfile.replace(/\\/g, '/')}`
);

try {
    // dropFailedEyesLines：独占行整条删
    {
        const t = '张三: 你看这个\n[眼睛 msgid:abc 第1张]: 加载不出来\n李四: 哈哈';
        const r = dropFailedEyesLines(t);
        assert.ok(!r.includes('加载不出来'), '失败眼睛行应删除');
        assert.ok(r.includes('张三: 你看这个'));
        assert.ok(r.includes('李四: 哈哈'));
    }
    // dropFailedEyesLines：加载超时同样删
    {
        const r = dropFailedEyesLines('[眼睛 msgid:x 第2张]: 加载超时');
        assert.strictEqual(r.trim(), '');
    }
    // 成功的眼睛行不动
    {
        const t = '[眼睛 msgid:abc 第1张]: 一张猫猫表情';
        const r = dropFailedEyesLines(t);
        assert.strictEqual(r, t);
    }
    // presentImageSupplementsForModel：dropFailed=true 丢失败图
    {
        const t = '王五: 看图\n[眼睛 msgid:m1 第1张]: 加载不出来';
        const withDrop = presentImageSupplementsForModel(t, 48, { dropFailed: true });
        assert.ok(!withDrop.includes('加载不出来'), '历史路径应丢失败图');
        const noDrop = presentImageSupplementsForModel(t, 48);
        assert.ok(noDrop.includes('加载不出来'), '当轮路径应保留占位');
    }
    // 成功图在历史路径按更短 cap 压缩，但保留
    {
        const longBody = '这是一张非常长的图片描述'.repeat(6);
        const t = `[眼睛 msgid:m2 第1张]: ${longBody}`;
        const r = presentImageSupplementsForModel(t, 40, { dropFailed: true });
        assert.ok(r.includes('[眼睛 msgid:m2 第1张]:'), '成功图应保留');
        const body = r.split(']:')[1] || '';
        assert.ok(body.length <= 48, `历史正文应被压短, got ${body.length}`);
    }
    console.log('verify-image-context: all passed');
} finally {
    removeTmpDir(tmpDir);
}
