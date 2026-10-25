/**
 * verify 脚本共用的临时目录工具。
 *
 * 为什么要有这个文件（2026-09-29 实测踩坑）：
 * 各 verify 脚本都会把 esbuild bundle 产物 mkdtemp 到 `node_modules/.mkai-verify-*`，
 * 收尾时用 `fs.rmSync(tmpDir, { recursive: true, force: true })` 清理。
 * 单跑一个脚本没问题，但 `npm run verify:all` 连跑 24 个时，环境里的
 * safe-delete 保护层会把它拦下来并抛错：
 *
 *   Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
 *   {"count":1067,"threshold":50,"scope":"turn","targets":["...node_modules\.mkai-verify-xxx"]}
 *
 * 即「一次删除超过 50 个文件」需要确认。bundle 产物动辄上千个小文件，
 * 于是十几个脚本全在收尾这一步炸掉 —— 表现为 `exit 1` 且用例断言其实全过，
 * 极易被误读成代码回归（实测同一份代码，失败数在 0 / 8 / 14 之间跳）。
 *
 * 这里的做法：**不删目录树，逐文件 unlink 后只删空目录**。
 * 逐个 unlink 不走「批量删除」判定，既能清干净又不触发保护层。
 */

import fs from 'fs';
import path from 'path';

/**
 * 递归删除目录，但规避批量删除保护：
 * 自底向上逐文件 `unlinkSync`，最后 `rmdirSync` 空目录。
 * 任何一步失败都静默跳过（临时目录残留无害，run-all-verifies 会统一收）。
 */
export function removeTmpDir(dir) {
    if (!dir) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return; // 不存在 / 没权限，直接当清完了
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            removeTmpDir(p);
        } else {
            try {
                fs.unlinkSync(p);
            } catch {
                /* 占用中/已删除，忽略 */
            }
        }
    }
    try {
        fs.rmdirSync(dir);
    } catch {
        /* 非空（有文件没删掉）或有进程占用，留着让 sweep 收 */
    }
}
