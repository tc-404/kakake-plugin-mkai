/**
 * 用智能对话 log 做回归对照：统计预判跳过 / completion=6 / send_msg。
 * 用法: node scripts/verify-force-speak-log.mjs [logDir]
 *
 * 注意：这是「拿真实日志做历史对照」的脚本，不是自包含验收。
 * 日志目录不存在时必须**失败**（exit 2），不能 exit 0 —— 否则接进批量套件后
 * 会变成一条永远绿灯的假测试。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultLog = process.env.MKAI_LOG_DIR || path.join(__dirname, '../../../其他数据/log');
const logDir = process.argv[2] || defaultLog;

if (!fs.existsSync(logDir)) {
  console.error(`verify-force-speak-log: 找不到日志目录 ${logDir}`);
  console.error('用法：node scripts/verify-force-speak-log.mjs <日志目录>（或设 MKAI_LOG_DIR）');
  console.error('说明：本脚本依赖真实运行日志，缺少日志属「无法执行」，不是「通过」。');
  process.exit(2);
}

const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort();
const stats = {
  llmCalls: 0,
  preSkip: 0,
  shutPred: 0,
  completion6: 0,
  sendMsg: 0,
  forceRescue: 0,
  streakAtLimitShut: 0,
};

for (const file of files) {
  const lines = fs.readFileSync(path.join(logDir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line.includes('kakake-plugin-mkai') && !line.includes('[智能对话]')) continue;
    if (line.includes('预判跳过 LLM')) stats.preSkip += 1;
    if (line.includes('闭嘴(预判)')) stats.shutPred += 1;
    if (/completion=6\b/.test(line)) stats.completion6 += 1;
    if (/tokens prompt=/.test(line)) stats.llmCalls += 1;
    if (line.includes('send_group_msg') || line.includes('send_private_msg') || /已发 /.test(line)) {
      /* 粗略：真正外发以 send 或出站为准 */
    }
    if (line.includes('send_msg') || /执行出站|已发消息/.test(line)) stats.sendMsg += 1;
    if (line.includes('达限强制') || line.includes('须开口但仍沉默') || line.includes('强制补一句')) {
      stats.forceRescue += 1;
    }
    const m = line.match(/闭嘴.*?streak→(\d+)\/(\d+)/);
    if (m) {
      const streak = Number(m[1]);
      const limit = Number(m[2]);
      if (streak > limit) stats.streakAtLimitShut += 1;
    }
  }
}

console.log('verify-force-speak-log (historical baseline from logs):');
console.log(JSON.stringify(stats, null, 2));
console.log(
  'Note: after forceSpeak patch, new logs should show streak>/limit shut ≈ 0 and forceRescue on @/达限.',
);
console.log('verify-force-speak-log: ok');
