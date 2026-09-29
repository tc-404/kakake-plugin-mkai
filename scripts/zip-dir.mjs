/**
 * 零依赖 ZIP 归档器。
 *
 * 为什么要自己写：项目没装 archiver/jszip 之类的压缩库，系统也没有 `zip` 命令，
 * 而 `Compress-Archive` 只能在 Windows 上跑（构建脚本要跨平台）。
 * ZIP 的 STORE（不压缩）格式本身很简单：每个文件一段「本地头 + 数据」，
 * 末尾再跟一份中央目录和 EOCD 记录 —— 不需要任何压缩算法实现。
 *
 * 不压缩是刻意的：插件产物大部分是 esbuild / vite 已经压过的 JS，
 * mjs/js 再走 deflate 收益很小，而 STORE 能保证字节完全一致、实现无风险。
 * 如果以后要压日志、图片之类，再考虑接 node:zlib 的 deflateRaw。
 *
 * 参考：PKWARE APPNOTE.TXT 4.3.7（本地文件头 / 中央目录 / EOCD 布局）
 */

import fs from 'fs';
import path from 'path';

/** DOS 时间格式：高 16 位是日期，低 16 位是时间 */
function toDosDateTime(date) {
    const d = date instanceof Date ? date : new Date();
    let year = d.getFullYear();
    // ZIP 的年份从 1980 起算；更早的时间会被钳到 1980
    if (year < 1980) year = 1980;
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/** CRC-32（IEEE 802.3，ZIP 用的那个多项式 0xEDB88320） */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

/**
 * 递归列出目录下的所有文件（相对路径，正斜杠）。
 * 自动跳过空目录 —— ZIP 里不需要它们。
 */
function walkFiles(rootDir, baseDir = rootDir) {
    const out = [];
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const e of entries) {
        const abs = path.join(baseDir, e.name);
        if (e.isDirectory()) {
            out.push(...walkFiles(rootDir, abs));
        } else if (e.isFile()) {
            const rel = path.relative(rootDir, abs).split(path.sep).join('/');
            out.push({ abs, rel });
        }
    }
    return out;
}

/**
 * 把 dir 打包成 zip 写到 outFile。
 *
 * @param {string} dir       要打包的目录
 * @param {string} outFile   目标 zip 路径
 * @param {object} [opts]
 * @param {string} [opts.rootName]  若提供，zip 内所有条目都放到这个顶层目录下
 *                                  （插件包习惯带一层同名目录，解压即得独立文件夹）
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{entries:number, bytes:number, outFile:string}}
 */
export function zipDirectory(dir, outFile, opts = {}) {
    const log = opts.log || (() => {});
    const rootName = String(opts.rootName || '').replace(/\\/g, '/').replace(/\/+$/, '');

    if (!fs.existsSync(dir)) {
        throw new Error(`要打包的目录不存在: ${dir}`);
    }
    const files = walkFiles(dir);
    if (!files.length) {
        throw new Error(`要打包的目录是空的: ${dir}`);
    }

    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const f of files) {
        const data = fs.readFileSync(f.abs);
        const name = rootName ? `${rootName}/${f.rel}` : f.rel;
        const nameBuf = Buffer.from(name, 'utf8');
        const { time, date } = toDosDateTime(fs.statSync(f.abs).mtime);
        const crc = crc32(data);

        // —— 本地文件头 (30 字节固定部分 + 文件名)
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); // 签名 PK\x03\x04
        local.writeUInt16LE(20, 4); // 解压所需版本 2.0
        local.writeUInt16LE(0x0800, 6); // 通用标志位：bit 11 = 文件名为 UTF-8
        local.writeUInt16LE(0, 8); // 压缩方法 0 = STORE
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); // 压缩后大小
        local.writeUInt32LE(data.length, 22); // 原始大小
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // 扩展字段长度
        localParts.push(local, nameBuf, data);

        // —— 中央目录项 (46 字节固定部分 + 文件名)
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // 签名 PK\x01\x02
        central.writeUInt16LE(20, 4); // 创建版本
        central.writeUInt16LE(20, 6); // 解压所需版本
        central.writeUInt16LE(0x0800, 8); // 同样带 UTF-8 标志
        central.writeUInt16LE(0, 10); // STORE
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // 扩展字段
        central.writeUInt16LE(0, 32); // 注释
        central.writeUInt16LE(0, 34); // 起始磁盘号
        central.writeUInt16LE(0, 36); // 内部属性
        central.writeUInt32LE(0, 38); // 外部属性
        central.writeUInt32LE(offset, 42); // 本地头偏移
        centralParts.push(central, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }

    const centralBuf = Buffer.concat(centralParts);

    // —— EOCD（中央目录结束记录）
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // 签名 PK\x05\x06
    eocd.writeUInt16LE(0, 4); // 当前磁盘号
    eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
    eocd.writeUInt16LE(files.length, 8); // 本磁盘条目数
    eocd.writeUInt16LE(files.length, 10); // 总条目数
    eocd.writeUInt32LE(centralBuf.length, 12); // 中央目录大小
    eocd.writeUInt32LE(offset, 16); // 中央目录偏移
    eocd.writeUInt16LE(0, 20); // 注释长度

    const zipBuf = Buffer.concat([...localParts, centralBuf, eocd]);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, zipBuf);
    log(`  打包 ${files.length} 个文件 → ${path.basename(outFile)}`);

    return { entries: files.length, bytes: zipBuf.length, outFile };
}

/**
 * 读回 zip 做自检：解析中央目录，校验条目数与 CRC。
 * 打包完顺手验一遍，比等用户解压失败再回头查强。
 */
export function verifyZip(zipFile) {
    const buf = fs.readFileSync(zipFile);
    // 从尾部往前找 EOCD 签名（注释最长 65535，但我们不写注释，直接看末尾 22 字节）
    const eocdOffset = buf.length - 22;
    if (eocdOffset < 0 || buf.readUInt32LE(eocdOffset) !== 0x06054b50) {
        throw new Error('ZIP 自检失败：找不到 EOCD 记录');
    }
    const total = buf.readUInt16LE(eocdOffset + 10);
    const centralSize = buf.readUInt32LE(eocdOffset + 12);
    const centralOffset = buf.readUInt32LE(eocdOffset + 16);

    if (buf.readUInt32LE(centralOffset) !== 0x02014b50) {
        throw new Error('ZIP 自检失败：中央目录签名不对');
    }
    if (centralOffset + centralSize !== eocdOffset) {
        throw new Error('ZIP 自检失败：中央目录大小与 EOCD 不一致');
    }

    // 逐个校验条目：读本地头 → 取数据 → 比对 CRC 与长度
    let p = centralOffset;
    for (let i = 0; i < total; i += 1) {
        const crc = buf.readUInt32LE(p + 16);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

        if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`ZIP 自检失败：${name} 的本地头签名不对`);
        }
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const data = buf.subarray(dataStart, dataStart + size);

        if (data.length !== size) {
            throw new Error(`ZIP 自检失败：${name} 数据长度不足`);
        }
        if (crc32(data) !== crc) {
            throw new Error(`ZIP 自检失败：${name} CRC 不匹配`);
        }
        p += 46 + nameLen + extraLen + commentLen;
    }

    return { entries: total, bytes: buf.length };
}
