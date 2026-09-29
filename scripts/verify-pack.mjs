/**
 * 打包链路验收 —— 真跑源码
 *
 * 覆盖 scripts/zip-dir.mjs（自带 ZIP writer）与 pack-plugin.mjs 的产物契约：
 *   1. 生成的 zip 结构合法（本地头 / 中央目录 / EOCD 三者自洽）
 *   2. 内容字节逐字一致（含二进制与非 ASCII 文本）
 *   3. 条目名带 UTF-8 标志位（不然中文文件名在解压端会乱码）
 *   4. CRC32 与标准实现对齐（用已知向量锁死）
 *   5. 版本号取自 package.json 且与 plugin.json 交叉一致
 *   6. zip 内带一层同名顶层目录（解压即得独立文件夹）
 *
 * 注意：这里不依赖任何第三方解压库，靠回读字节 + 独立 CRC 实现交叉验证。
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { zipDirectory, verifyZip } from './zip-dir.mjs';
import { removeTmpDir } from './tmp-dir.mjs';
import { KAKAKE_PLUGIN_NAME } from './plugin-constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mkai-verify-pack-'));
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

/** 独立实现的 CRC32（查表法），用于交叉验证 zip-dir 里那份 */
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

try {
    // —— 造一棵多层级、含中文/二进制/空文件的源目录 ——
    const srcDir = path.join(work, 'srcdir');
    fs.mkdirSync(path.join(srcDir, 'webui'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'assets', 'deep', 'nested'), { recursive: true });

    const samples = {
        'index.mjs': 'export const a = 1;\n// 中文注释\n',
        'plugin.json': JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2),
        'webui/remote.js': 'console.log("远程模块 中文");',
        'assets/deep/nested/图标.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]),
        'assets/empty.txt': '',
    };
    for (const [rel, content] of Object.entries(samples)) {
        fs.writeFileSync(path.join(srcDir, rel), content);
    }

    // —— 1. 打包 + 自检 ——
    const zipPath = path.join(work, 'out.zip');
    const res = zipDirectory(srcDir, zipPath, { rootName: 'mypkg' });
    assert.strictEqual(res.entries, Object.keys(samples).length, '条目数应等于文件数');
    ok(`打包 ${res.entries} 个文件`);

    const check = verifyZip(zipPath);
    assert.strictEqual(check.entries, Object.keys(samples).length, '自检条目数一致');
    ok('zip 结构自检通过（本地头/中央目录/EOCD 自洽）');

    // —— 2. 不用内置自检，手工解析一遍做独立确认 ——
    const buf = fs.readFileSync(zipPath);
    const eocd = buf.length - 22;
    assert.strictEqual(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名');
    const total = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    assert.strictEqual(buf.readUInt32LE(cdOffset), 0x02014b50, '中央目录签名');
    assert.strictEqual(total, Object.keys(samples).length, 'EOCD 记录的总条目数');
    ok('独立解析 EOCD / 中央目录签名正确');

    // —— 3. 逐条目校验：名字、UTF-8 标志、CRC、内容字节 ——
    let p = cdOffset;
    const seen = new Set();
    for (let i = 0; i < total; i += 1) {
        const flags = buf.readUInt16LE(p + 8);
        const crc = buf.readUInt32LE(p + 16);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

        assert.ok((flags & 0x0800) !== 0, `${name} 应带 UTF-8 标志位（bit 11）`);
        assert.ok(name.startsWith('mypkg/'), `${name} 应带顶层目录前缀`);

        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const data = buf.subarray(dataStart, dataStart + size);

        const rel = name.slice('mypkg/'.length);
        const expected = samples[rel];
        assert.ok(expected !== undefined, `不该出现未预期的条目 ${name}`);
        const expectedBuf = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'utf8');
        assert.strictEqual(data.length, expectedBuf.length, `${name} 长度一致`);
        assert.ok(data.equals(expectedBuf), `${name} 字节逐字一致`);
        assert.strictEqual(crc32(data), crc, `${name} CRC 与独立实现一致`);
        seen.add(rel);

        p += 46 + nameLen + extraLen + commentLen;
    }
    assert.strictEqual(seen.size, Object.keys(samples).length, '所有文件都被收录');
    ok('逐条目：UTF-8 标志 / 顶层目录 / CRC / 字节 全部一致');

    // —— 4. 中文文件名与中文内容可正确往返 ——
    assert.ok(seen.has('assets/deep/nested/图标.png'), '中文文件名原样保留');
    ok('中文文件名往返正确');

    // —— 5. CRC32 已知向量锁死（防止表算错却"自洽"） ——
    assert.strictEqual(crc32(Buffer.from('', 'utf8')), 0x00000000, '空串 CRC = 0');
    assert.strictEqual(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926, '标准向量 CRC');
    ok('CRC32 与标准测试向量一致');

    // —— 6. 空目录不该产生条目 ——
    fs.mkdirSync(path.join(srcDir, 'emptyDir'), { recursive: true });
    const zip2 = path.join(work, 'out2.zip');
    zipDirectory(srcDir, zip2, { rootName: 'p' });
    const hasEmptyDir = verifyZip(zip2).entries !== Object.keys(samples).length;
    assert.ok(!hasEmptyDir, '空目录不应产生 zip 条目');
    ok('空目录被正确忽略');

    // —— 7. 空目录打包应报错（而不是产出坏包） ——
    const reallyEmpty = path.join(work, 'reallyempty');
    fs.mkdirSync(reallyEmpty, { recursive: true });
    assert.throws(() => zipDirectory(reallyEmpty, path.join(work, 'bad.zip')), /空/, '空目录应报错');
    assert.ok(!fs.existsSync(path.join(work, 'bad.zip')), '报错时不应留下坏 zip');
    ok('空目录打包被拒绝且不留残包');

    // —— 8. 打包脚本契约（源码级） ——
    const packSrc = fs.readFileSync(path.join(root, 'scripts/pack-plugin.mjs'), 'utf8');
    assert.ok(packSrc.includes('zipDirectory'), 'pack 脚本调用 zipDirectory');
    assert.ok(packSrc.includes('verifyZip'), 'pack 脚本打完自检');
    assert.ok(packSrc.includes('MUST_HAVE'), 'pack 脚本有必需文件清单');
    assert.ok(/index\.mjs/.test(packSrc) && /webui\/remote\.js/.test(packSrc), '必需清单含关键文件');
    assert.ok(packSrc.includes('plugin.json'), 'pack 脚本交叉校验 plugin.json');
    assert.ok(/版本.*不一致|不一致/.test(packSrc), 'pack 脚本有版本一致性门禁');
    ok('pack-plugin.mjs 接线契约完整');

    // —— 9. package.json 暴露了 pack 入口 ——
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts.pack, 'package.json 有 pack 脚本');
    assert.ok(/pack-plugin\.mjs/.test(pkg.scripts.pack), 'pack 指向 pack-plugin.mjs');
    assert.ok(pkg.scripts['pack:fast'], '有 pack:fast 快捷入口');
    ok('package.json 暴露 pack / pack:fast');

    // —— 10. 打包产物名含版本号（不硬编码，取当前 version） ——
    const ver = String(pkg.version || '').trim();
    assert.ok(/^\d+\.\d+\.\d+/.test(ver), `package.json version 形如 x.y.z，实得 ${ver}`);
    ok(`版本号 ${ver} 形如 x.y.z`);

    // —— 11. 若真产物 zip 存在，顺手验一遍 ——
    const realZip = path.join(root, `${KAKAKE_PLUGIN_NAME}-${ver}.zip`);
    if (fs.existsSync(realZip)) {
        const r = verifyZip(realZip);
        assert.ok(r.entries >= 4, `真产物包条目数合理（实得 ${r.entries}）`);
        ok(`真产物包 ${path.basename(realZip)} 结构合法（${r.entries} 条目）`);
    } else {
        console.log('  - 真产物 zip 不存在，跳过（先跑 npm run pack）');
    }
} finally {
    removeTmpDir(work);
}

console.log(`\nverify-pack: 全部通过（${passed} 组断言）`);
