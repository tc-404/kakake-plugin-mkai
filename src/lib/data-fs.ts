import fs from 'fs';
import path from 'path';

type LogFn = (...args: unknown[]) => void;
type Logger = { error?: LogFn; warn?: LogFn; info?: LogFn; log?: LogFn; debug?: LogFn };

let dataPath = '';
let logger: Logger = {};

export function bindLogger(next: Logger): void {
  logger = next || {};
}

export function setDataPath(dir: string): void {
  dataPath = dir;
}

export function getDataPath(): string {
  return dataPath;
}

/**
 * 相对文件名解析 + 越界拦截（落盘层最后一道闸）。
 *
 * 为什么放在这里：会话/缓冲/记忆的路径都由字符串拼出来
 * （`${ROOT}${fingerprint}/${chatId}.json`），而 `path.join` 会把 `../` 归一化掉。
 * 面板传来的 chatId/fingerprint 一旦是 `../../..` 就能读写数据目录之外的文件
 * （含本插件自己的 config.json，里面有明文密钥）。路由层已经加了白名单，
 * 这里再加一道「解析结果必须留在 dataPath 内」的硬断言，防止以后新增调用点漏掉校验。
 *
 * 绝对路径仍按原样放行（插件内部若显式传入绝对路径，语义就是「就用这个文件」）。
 */
function resolveDataFile(filename: string): { filePath: string; blocked: boolean } {
  const name = String(filename ?? '');
  if (path.isAbsolute(name)) return { filePath: name, blocked: false };
  const root = path.resolve(dataPath || '.');
  const abs = path.resolve(root, name);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { filePath: abs, blocked: true };
  }
  return { filePath: abs, blocked: false };
}

/**
 * 原子写：先写同目录 .tmp，再 rename 覆盖目标。
 *
 * 为什么必须换掉 writeFileSync 直写：直写先截断后写入，进程被杀/磁盘满时会留下
 * 半截 JSON，而所有读取端 catch 之后都当「空」处理 —— 一次断电就能把整会话/整份
 * 开关表变成空文件，且原始内容已经没了。
 *
 * Windows 上 rename 覆盖已存在文件是原子的（MoveFileEx + REPLACE_EXISTING），
 * 但可能被索引/杀软短暂占用而 EPERM，所以失败时重试一次再退回直写（仍比原来好：
 * 至少不会先截断目标文件）。
 */
function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
    return;
  } catch (firstError) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch {
      /* 落到下面的直写兜底 */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    logger.warn?.(`[MK_AI] 原子写 rename 失败，退回直写 ${path.basename(filePath)}:`, firstError);
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

export function readA(filename: string): string {
  const { filePath, blocked } = resolveDataFile(filename);
  if (blocked) {
    logger.error?.(`[MK_AI] 拒绝越界读取 ${filename}`);
    return '';
  }
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.error?.(`[MK_AI] 读取文件 ${filename} 失败:`, error);
  }
  return '';
}

export function writeA(filename: string, content: string): boolean {
  const { filePath, blocked } = resolveDataFile(filename);
  if (blocked) {
    logger.error?.(`[MK_AI] 拒绝越界写入 ${filename}`);
    return false;
  }
  try {
    writeFileAtomic(filePath, content);
    return true;
  } catch (error) {
    logger.error?.(`[MK_AI] 写入文件 ${filename} 失败:`, error);
    return false;
  }
}

export function readB(filename: string, key: string, defaultValue: unknown = ''): unknown {
  const { filePath, blocked } = resolveDataFile(filename);
  if (blocked) {
    logger.error?.(`[MK_AI] 拒绝越界读取 ${filename}`);
    return defaultValue;
  }
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (key in data && data[key] !== null && data[key] !== undefined) return data[key];
    }
  } catch (error) {
    logger.error?.(`[MK_AI] 读取键 ${filename}/${key} 失败:`, error);
  }
  return defaultValue;
}

export function writeB(filename: string, key: string, value: unknown): boolean {
  const { filePath, blocked } = resolveDataFile(filename);
  if (blocked) {
    logger.error?.(`[MK_AI] 拒绝越界写入 ${filename}`);
    return false;
  }
  try {
    let data: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (error) {
        logger.error?.(`[MK_AI] 读取键 ${filename}/${key} 失败:`, error);
        return false;
      }
      if (raw.trim()) {
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch (error) {
          // 原来这里 catch 成 {} 之后直接写回，等于「拨一个群的开关」把同文件里
          // 其它所有群的开关一起清掉（群聊开关.json / 轮次群.json 等 ~30 个调用点）。
          // 现在先把坏文件改名留档（可人工抢救），再重建，并打错误日志。
          const backup = `${filePath}.corrupt-${Date.now()}`;
          try {
            fs.renameSync(filePath, backup);
            logger.error?.(
              `[MK_AI] ${filename} 内容损坏，已备份为 ${path.basename(backup)} 后重建（键 ${key}）`,
              error,
            );
          } catch (renameError) {
            logger.error?.(`[MK_AI] ${filename} 内容损坏且备份失败，本次写入放弃`, renameError);
            return false;
          }
        }
      }
    }
    data[key] = value;
    writeFileAtomic(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    logger.error?.(`[MK_AI] 写入键 ${filename}/${key} 失败:`, error);
    return false;
  }
}
