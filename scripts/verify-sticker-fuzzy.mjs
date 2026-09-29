/**
 * A1 送图模糊兜底回归：模型给的文件名不存在/扩展名错/含义相近时，
 * 在同图库真实文件里模糊匹配到最接近的一张（尊重模型「想发这个情绪」的决定），
 * 而不是让插件替它认栽发写死句。不调真实 API。
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
const tmpDir = fs.mkdtempSync(path.join(nmDir, '.mkai-verify-fuzzy-'));

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

const { fuzzyResolveStickerInGallery, runListStickers } = await loadModule('src/auth/smart-chat-sticker.ts');

// 临时图库结构：dataRoot 的上两级/表情图库/菲比 才是图库根
const workDir = fs.mkdtempSync(path.join(nmDir, '.mkai-fuzzy-fs-'));
const dataRoot = path.join(workDir, '数据', '子目录', 'x');
fs.mkdirSync(dataRoot, { recursive: true });
const feibiDir = path.join(workDir, '数据', '表情图库', '菲比');
fs.mkdirSync(feibiDir, { recursive: true });
fs.writeFileSync(path.join(feibiDir, '开心.png'), 'x');
fs.writeFileSync(path.join(feibiDir, '无语.webp'), 'x');
fs.writeFileSync(path.join(feibiDir, '气到跳脚.gif'), 'x');

const deps = { getDataPath: () => dataRoot };

try {
    // 1) 严格命中：原样返回，fuzzy=false
    {
        const r = fuzzyResolveStickerInGallery(deps, '菲比/开心.png');
        assert.ok(r.ok, '严格命中应成功');
        assert.strictEqual(r.fuzzy, false);
        assert.strictEqual(r.rel, '菲比/开心.png');
    }
    // 2) 扩展名写错：兜底到真实文件
    {
        const r = fuzzyResolveStickerInGallery(deps, '菲比/开心.jpg');
        assert.ok(r.ok, '扩展名错应模糊命中');
        assert.strictEqual(r.fuzzy, true);
        assert.strictEqual(r.rel, '菲比/开心.png');
    }
    // 3) 含义包含（模型多写了修饰）：兜底到 开心
    {
        const r = fuzzyResolveStickerInGallery(deps, '菲比/开心大笑.webp');
        assert.ok(r.ok, '含义包含应模糊命中');
        assert.strictEqual(r.fuzzy, true);
        assert.strictEqual(r.rel, '菲比/开心.png');
    }
    // 4) 前缀序号/符号差异：气死→气到跳脚（含「气」连续重叠不足则不强配）
    {
        const r = fuzzyResolveStickerInGallery(deps, '菲比/气到跳.png');
        assert.ok(r.ok, '子串包含应模糊命中');
        assert.strictEqual(r.rel, '菲比/气到跳脚.gif');
    }
    // 5) 完全不相干：宁可失败让上层沉默，不乱配
    {
        const r = fuzzyResolveStickerInGallery(deps, '菲比/彻底无关的东西.png');
        assert.ok(!r.ok, '不相干不应强行匹配');
    }
    // 6) 未安装图库：不救，返回严格错误
    {
        const r = fuzzyResolveStickerInGallery(deps, '呆猫八条/随便.png');
        assert.ok(!r.ok, '未装图库不应模糊命中');
    }
    // 7) 未知图库：不救
    {
        const r = fuzzyResolveStickerInGallery(deps, '不存在的库/x.png');
        assert.ok(!r.ok);
    }

    // --- A4 list_stickers：按情绪返回真实文件名 ---
    {
        const r = JSON.parse(runListStickers(deps, '开心'));
        assert.ok(r.ok, 'list_stickers 应成功');
        assert.ok(Array.isArray(r.matches) && r.matches.length > 0);
        assert.ok(r.matches.includes('菲比/开心.png'), '应含真实的 开心.png');
        // 返回的都是真实存在的路径
        for (const rel of r.matches) {
            const res = fuzzyResolveStickerInGallery(deps, rel);
            assert.ok(res.ok && res.fuzzy === false, `list 返回的应严格命中: ${rel}`);
        }
    }
    // 空 emotion：返回样例概览
    {
        const r = JSON.parse(runListStickers(deps, ''));
        assert.ok(r.ok);
        assert.ok(r.matches.length > 0);
        assert.strictEqual(r.total, 3);
    }
    // 未装图库场景
    {
        const emptyDeps = { getDataPath: () => path.join(workDir, '空', '子', 'x') };
        const r = JSON.parse(runListStickers(emptyDeps, '开心'));
        assert.ok(!r.ok, '未装图库应返回失败');
    }
    console.log('verify-sticker-fuzzy: all passed');
} finally {
    removeTmpDir(tmpDir);
    removeTmpDir(workDir);
}
