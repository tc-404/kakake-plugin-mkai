/**
 * 打包插件：构建 → 校验 → 压缩 zip。
 *
 * 用法：
 *   node scripts/pack-plugin.mjs                 # 构建 + 打包（默认）
 *   node scripts/pack-plugin.mjs --no-build      # 跳过构建，直接打当前产物
 *   node scripts/pack-plugin.mjs --skip-verify   # 跳过校验（赶时间时用）
 *   node scripts/pack-plugin.mjs --keep-only     # 除了 zip 不留多余中间物
 *
 * 产物：
 *   kakake-plugin-mkai/                    （目录，供本机直接加载）
 *   kakake-plugin-mkai-<version>.zip       （带版本号，同名覆盖，便于分发）
 *
 * 版本号取自 package.json 的 version，并与产物 plugin.json 交叉校验 ——
 * 两边对不上直接报错，避免发出「包名标的是旧版本、实际装的是新代码」这种坑
 * （README 里提过发型号要手动统一递增，这里把它变成自动门禁）。
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { zipDirectory, verifyZip } from './zip-dir.mjs';
import { KAKAKE_PLUGIN_NAME } from './plugin-constants.mjs';
import { removeTmpDir } from './tmp-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const distDir = path.join(root, KAKAKE_PLUGIN_NAME);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const doBuild = !has('--no-build');
const doVerify = !has('--skip-verify');

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function die(msg) {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
}

function run(cmd, label) {
    console.log(`\n▸ ${label}`);
    const r = spawnSync(cmd, {
        cwd: root,
        stdio: 'inherit',
        shell: true,
    });
    if (r.status !== 0) die(`${label} 失败（exit ${r.status}）`);
}

console.log('════════ 打包 kakake-plugin-mkai ════════');

// —— 版本号：package.json 为准，与产物 plugin.json 交叉校验 ——
const pkgPath = path.join(root, 'package.json');
const pkg = readJson(pkgPath);
const version = String(pkg.version || '').trim();
if (!version) die('package.json 缺 version 字段');

const rootPluginJson = path.join(root, 'plugin.json');
if (fs.existsSync(rootPluginJson)) {
    const v = String(readJson(rootPluginJson).version || '').trim();
    if (v && v !== version) {
        die(`版本号不一致：package.json=${version}，plugin.json=${v}\n  发布前请把两处改一致`);
    }
}
console.log(`  版本 ${version}`);

// —— 1. 构建 ——
if (doBuild) {
    run('npm run build', '构建（typecheck + webui + vite）');
} else {
    console.log('\n▸ 跳过构建（--no-build）');
}

// —— 2. 产物存在性 + plugin.json 一致性 ——
if (!fs.existsSync(distDir)) die(`产物目录不存在：${distDir}`);
const distPluginJson = path.join(distDir, 'plugin.json');
if (!fs.existsSync(distPluginJson)) die('产物缺 plugin.json');
const dv = String(readJson(distPluginJson).version || '').trim();
if (dv !== version) {
    die(`产物 plugin.json 版本(${dv}) 与 package.json(${version}) 不一致，请检查构建流程`);
}

// 关键文件清单：缺任何一个都是废包
const MUST_HAVE = ['index.mjs', 'plugin.json', 'webui/remote.js'];
const missing = MUST_HAVE.filter((f) => !fs.existsSync(path.join(distDir, f)));
if (missing.length) die(`产物缺关键文件：${missing.join(', ')}`);

// —— 3. 校验（可选）——
if (doVerify) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run-all-verifies.mjs')], {
        cwd: root,
        stdio: 'inherit',
    });
    if (r.status !== 0) {
        console.warn('\n⚠ 校验未全部通过。若确认与本次改动无关，可加 --skip-verify 重试。');
        die('校验失败，已中止打包');
    }
} else {
    console.log('\n▸ 跳过校验（--skip-verify）');
}

// —— 4. 打 zip ——
const zipName = `${KAKAKE_PLUGIN_NAME}-${version}.zip`;
const zipPath = path.join(root, zipName);

// 同名旧包先删掉：STORE 方式重写即可，但保留旧文件会让「到底哪个是新的」变模糊
if (fs.existsSync(zipPath)) {
    try {
        fs.unlinkSync(zipPath);
    } catch (e) {
        die(`无法覆盖已存在的 ${zipName}：${e.message}`);
    }
}

console.log('\n▸ 压缩');
const res = zipDirectory(distDir, zipPath, {
    rootName: KAKAKE_PLUGIN_NAME, // zip 内带一层同名目录，解压即得独立文件夹
    log: (m) => console.log(m),
});

// —— 5. 自检 ——
const check = verifyZip(zipPath);
const sizeMB = (check.bytes / 1024 / 1024).toFixed(2);
console.log(`  自检通过：${check.entries} 个条目，${sizeMB} MB，CRC 全部匹配`);

// —— 附：产物摘要，方便肉眼确认没漏文件 ——
console.log('\n▸ 包内容');
for (const f of MUST_HAVE) {
    const size = fs.statSync(path.join(distDir, f)).size;
    console.log(`  ${f.padEnd(20)} ${(size / 1024).toFixed(1)} KB`);
}

console.log(`\n✓ 打包完成`);
console.log(`  目录  ${KAKAKE_PLUGIN_NAME}/`);
console.log(`  压缩  ${zipName}  (${sizeMB} MB)`);
console.log(`\n  安装：把 ${zipName} 解压到 Kakake 插件目录后加载`);
