/** 将智能对话 session.messages 展开为聊天气泡（用户左 / 机器人右） */

export type ChatBubble = {
  id: string;
  side: 'in' | 'out' | 'sys';
  name: string;
  qq?: string;
  time?: string;
  text: string;
  kind?: 'msg' | 'shut_up' | 'react' | 'sticker' | 'compact' | 'eyes' | 'voice';
  /** 原图消息挂载的识图备注（按张序） */
  imageNotes?: string[];
  /** 入站 msgid，用于挂载识图 */
  messageId?: string;
  /** 群身份标记 */
  groupRole?: 'owner' | 'admin' | 'member';
  /** 群专属头衔（没挂头衔时不存在） */
  groupTitle?: string;
  /** 引用摘要（给人看） */
  replyTo?: string;
  /** 艾特对象（给人看） */
  atTargets?: string;
};

export type SessionMessage = {
  role?: string;
  content?: string;
};

export type SessionDetail = {
  messages?: SessionMessage[];
  chat_type?: string;
  group_id?: string;
  group_name?: string;
  bot_nickname?: string;
  bot_card?: string;
};

const TIME_HEAD_RE = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\]\s+/;
const EYES_LINE_RE = /^\[眼睛\s+msgid:(\S+)\s+第(\d+)张\]:\s*(.*)$/i;
const SUPPLEMENT_LINE_RE = /^补充：(\S+)\s*图片第(\d+)张解析结果\s*(.*)$/i;
/** 入站图片占位（含 msgid、发了N张、解析中提示）——仅 WebUI 展示时剥掉 */
const IMAGE_PLACEHOLDER_RE = /\d{5,20}\s*发了\d+张\[图片\][^\n]*/g;
const IMAGE_PARSING_HINT_RE = /(?:\(|（)?图片资源正在解析[^)\n）]*(?:\)|）)?/g;

function isImagePlaceholderLine(line: string): boolean {
  return /^\d{5,20}\s*发了\d+张\[图片\]/i.test(String(line || '').trim());
}

/** 剥掉图片占位/解析提示，供后台气泡正文展示 */
function sanitizeInboundDisplayText(raw: string): { text: string; hadImagePlaceholder: boolean } {
  const rawStr = String(raw || '');
  const hadImagePlaceholder = IMAGE_PLACEHOLDER_RE.test(rawStr);
  const text = rawStr
    .replace(IMAGE_PLACEHOLDER_RE, '')
    .replace(IMAGE_PARSING_HINT_RE, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return { text, hadImagePlaceholder };
}

function finalizeInboundDisplayText(raw: string, messageId?: string): string {
  const { text, hadImagePlaceholder } = sanitizeInboundDisplayText(raw);
  if (text) return text;
  if (hadImagePlaceholder || messageId) return '[图片]';
  return '（空消息）';
}

function stripHostBlocks(raw: string): string {
  return String(raw || '')
    .replace(/<memory-recall>[\s\S]*?<\/memory-recall>/gi, '')
    .replace(/<host-state>[\s\S]*?<\/host-state>/gi, '')
    .replace(/<skill-tree>[\s\S]*?<\/skill-tree>/gi, '')
    .replace(/<\/?(?:batch-messages|main-visit|side-context|compaction-summary)>/gi, '\n')
    .replace(/（(?:主访问|次访问)[^）]*）\n?/g, '')
    .replace(/\[compact[^\]]*\]\n?/gi, '')
    .replace(/说明：以下为远史压缩[\s\S]*?(?=\n\[|\n<main-visit|\n<batch-messages|$)/gi, '')
    .replace(/<\/?digest-(?:stance|users|assistants)>/gi, '\n');
}

/** 从 `[tag]` 起解析一个完整方括号段（引用摘要里可能含 `[图片]` 等） */
function extractBracketTag(input: string): { inner: string; rest: string } | null {
  if (!input.startsWith('[')) return null;
  for (let i = 1; i < input.length; i += 1) {
    if (input[i] !== ']') continue;
    const tail = input.slice(i + 1);
    if (/^\s*(?:\[|:|$)/.test(tail)) {
      return { inner: input.slice(1, i), rest: tail.trimStart() };
    }
  }
  return null;
}

function parseMetaTags(raw: string): { tags: string[]; body: string } | null {
  let rest = String(raw || '').trimStart();
  const tags: string[] = [];
  while (rest.startsWith('[')) {
    const tag = extractBracketTag(rest);
    if (!tag) return null;
    tags.push(tag.inner);
    rest = tag.rest.trimStart();
  }
  if (!rest.startsWith(':')) return null;
  const body = rest.replace(/^:\s?/, '');
  return { tags, body };
}

function parseGroupRole(tags: string[]): ChatBubble['groupRole'] {
  if (tags.includes('群主')) return 'owner';
  if (tags.includes('管理')) return 'admin';
  if (tags.includes('成员')) return 'member';
  return undefined;
}

/** 头衔标记 `[头衔:xxx]`；没挂头衔的消息里没有这段 */
function parseGroupTitle(tags: string[]): string | undefined {
  for (const t of tags) {
    const m = t.match(/^头衔:(.+)$/);
    if (m) {
      const v = String(m[1] || '').trim();
      if (v) return v;
    }
  }
  return undefined;
}

function extractMsgidFromTags(tags: string[]): string {
  for (const t of tags) {
    const m = t.match(/^msgid:(.+)$/i);
    if (m) return String(m[1] || '').trim();
  }
  return '';
}

function formatReplyTag(inner: string): string {
  const raw = String(inner || '').replace(/^引用→/, '').trim();
  if (!raw) return '引用消息';
  const snip = raw.match(/「([^」]*)」/);
  const head = raw.replace(/\s*「[^」]*」\s*$/, '').trim();
  if (snip && head) return `引用 ${head}：${snip[1]}`;
  if (snip) return `引用：${snip[1]}`;
  return `引用 ${head || raw}`;
}

function formatAtTag(inner: string): string {
  const raw = String(inner || '').replace(/^艾特:/, '').trim();
  return raw ? `@ ${raw}` : '@';
}

function displayMetaFromTags(tags: string[]): Pick<ChatBubble, 'groupRole' | 'groupTitle' | 'replyTo' | 'atTargets'> {
  let replyTo: string | undefined;
  let atTargets: string | undefined;
  for (const t of tags) {
    if (t.startsWith('引用→')) {
      replyTo = formatReplyTag(t);
    } else if (t.startsWith('艾特:')) {
      atTargets = atTargets ? `${atTargets}、${formatAtTag(t).replace(/^@ /, '')}` : formatAtTag(t);
    }
  }
  return { groupRole: parseGroupRole(tags), groupTitle: parseGroupTitle(tags), replyTo, atTargets };
}

function extractMsgidFromBody(body: string): string {
  const m = String(body || '').match(/^(\d{5,20})\s*发了\d+张\[图片\]/);
  return m ? String(m[1] || '').trim() : '';
}

function clipNote(text: string, max = 280): string {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** msgid → (张序号 → 备注正文) */
export type ImageNotesMap = Map<string, Map<number, string>>;

function setImageNote(map: ImageNotesMap, mid: string, index: number, body: string): void {
  const id = String(mid || '').trim();
  if (!id) return;
  const idx = Math.max(1, Number(index) || 1);
  const note = clipNote(body || '（图片）');
  if (!note) return;
  if (!map.has(id)) map.set(id, new Map());
  const slot = map.get(id)!;
  slot.set(idx, note);
}

/** 从整段会话收集识图备注，便于挂到原图消息底部（不跟补充出现的时间走） */
export function collectImageNotesMap(messages: SessionMessage[]): ImageNotesMap {
  const map: ImageNotesMap = new Map();
  for (const msg of messages || []) {
    const role = String(msg.role || '').toLowerCase();
    if (role !== 'user' && role !== 'human') continue;
    const text = stripHostBlocks(String(msg.content || ''));
    for (const rawLine of text.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let m = line.match(EYES_LINE_RE);
      if (m) {
        setImageNote(map, m[1], Number(m[2]), m[3] || '');
        continue;
      }
      m = line.match(SUPPLEMENT_LINE_RE);
      if (m) {
        setImageNote(map, m[1], Number(m[2]), m[3] || '');
        continue;
      }
      for (const em of line.matchAll(/\[眼睛\s+msgid:(\S+)\s+第(\d+)张\]:\s*([^\n\[]*)/gi)) {
        setImageNote(map, em[1], Number(em[2]), em[3] || '');
      }
      for (const sm of line.matchAll(/补充：(\S+)\s*图片第(\d+)张解析结果\s*([^\n]*)/gi)) {
        setImageNote(map, sm[1], Number(sm[2]), sm[3] || '');
      }
    }
  }
  return map;
}

export function notesForMessage(map: ImageNotesMap, messageId: string): string[] {
  const id = String(messageId || '').trim();
  if (!id || !map.has(id)) return [];
  const slot = map.get(id)!;
  const idxs = [...slot.keys()].sort((a, b) => a - b);
  if (idxs.length === 1) return [slot.get(idxs[0])!];
  return idxs.map((i) => `第${i}张：${slot.get(i)}`);
}

function isEyesOrSupplementLine(line: string): boolean {
  const t = String(line || '').trim();
  return EYES_LINE_RE.test(t) || SUPPLEMENT_LINE_RE.test(t);
}

type ParsedInbound = Omit<ChatBubble, 'id' | 'side'>;

function parseInboundLine(line: string): ParsedInbound | null {
  const head = line.match(TIME_HEAD_RE);
  if (!head) return null;
  const time = head[1].replace('T', ' ');
  const rest = line.slice(head[0].length);
  // 必须取行首第一个 nick(qq)，引用/艾特标注里也会带 (QQ)
  const qqMatch = rest.match(/^(.+?)\((\d{5,15})\)\s+/);
  if (!qqMatch) return null;
  const name = String(qqMatch[1] || '').trim();
  const qq = qqMatch[2];
  const parsed = parseMetaTags(rest.slice(qqMatch[0].length));
  if (!parsed) return null;

  let body = parsed.body.trim();
  if (/^补充：\S*\s*图片第\d+张解析结果/i.test(body) || /^\[眼睛\s+msgid:/i.test(body)) {
    return null;
  }

  const msgid = extractMsgidFromTags(parsed.tags) || extractMsgidFromBody(body);
  return {
    name: name || qq,
    qq,
    time,
    text: finalizeInboundDisplayText(body, msgid),
    kind: 'msg',
    messageId: msgid || undefined,
    ...displayMetaFromTags(parsed.tags),
  };
}

function sortInboundBubbles(items: ParsedInbound[]): ParsedInbound[] {
  return [...items].sort((a, b) => {
    const ta = String(a.time || '');
    const tb = String(b.time || '');
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    const ma = String(a.messageId || '');
    const mb = String(b.messageId || '');
    if (ma && mb && ma !== mb) return ma.localeCompare(mb, undefined, { numeric: true });
    return 0;
  });
}

function parseInboundChunk(
  chunk: string,
  seq: { n: number },
  notesMap: ImageNotesMap,
  attachedIds: Set<string>,
): ChatBubble[] {
  const text = stripHostBlocks(chunk);
  const lines = text.split(/\n+/);
  const parsedRows: ParsedInbound[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\[compact/i.test(line) || line.startsWith('说明：') || line.startsWith('（已并入')) continue;
    if (/^[-•·]\s/.test(line) && line.length < 120) continue;
    if (isEyesOrSupplementLine(line)) continue;

    const row = parseInboundLine(line);
    if (row) {
      parsedRows.push(row);
      continue;
    }

    if (isEyesOrSupplementLine(line)) continue;
    // 图片占位续行仅用于模型/识图挂载，后台气泡不展示
    if (isImagePlaceholderLine(line)) continue;
    // 新时间戳行解析失败也不并入上一条（避免多人消息糊成一泡）
    if (TIME_HEAD_RE.test(line)) continue;
    if (parsedRows.length && !/^</.test(line)) {
      const prev = parsedRows[parsedRows.length - 1];
      if (prev.text.length < 400) {
        prev.text = finalizeInboundDisplayText(`${prev.text}\n${line}`, prev.messageId);
      }
    }
  }

  for (const row of parsedRows) {
    row.text = finalizeInboundDisplayText(row.text, row.messageId);
  }

  const out: ChatBubble[] = [];
  for (const row of sortInboundBubbles(parsedRows)) {
    const msgid = row.messageId || '';
    const imageNotes = msgid ? notesForMessage(notesMap, msgid) : [];
    if (msgid && imageNotes.length) attachedIds.add(msgid);
    out.push({
      id: `in-${seq.n++}`,
      side: 'in',
      ...row,
      imageNotes: imageNotes.length ? imageNotes : undefined,
    });
  }
  return out;
}

function parseAssistantChunk(content: string, botName: string, seq: { n: number }): ChatBubble[] {
  const raw = String(content || '').trim();
  if (!raw) return [];

  if (/^<shut_up\s*\/?>$/i.test(raw) || (/^<shut_up\s*\/>/i.test(raw) && !/<msg\b/i.test(raw))) {
    return [{
      id: `sys-${seq.n++}`,
      side: 'sys',
      name: botName,
      text: '（沉默旁听）',
      kind: 'shut_up',
    }];
  }

  const out: ChatBubble[] = [];
  const msgRe = /<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi;
  let m: RegExpExecArray | null;
  while ((m = msgRe.exec(raw))) {
    const attrs = m[1] || '';
    let text = String(m[2] || '').trim();
    const stickerAttr = attrs.match(/\bsticker\s*=\s*"([^"]+)"/i);
    if (stickerAttr) {
      out.push({
        id: `out-${seq.n++}`,
        side: 'out',
        name: botName,
        text: `[表情包] ${stickerAttr[1]}`,
        kind: 'sticker',
      });
    }
    if (text) {
      out.push({
        id: `out-${seq.n++}`,
        side: 'out',
        name: botName,
        text,
        kind: 'msg',
      });
    }
  }

  // 语音气泡：模型点名要发语音的 <voice> 段，后台按「[语音]正文」显示，
  // 与出站历史里的记号对齐（历史里保留 <voice> 让模型知道自己刚用语音说了这句）
  const voiceRe = /<voice>([\s\S]*?)<\/voice>/gi;
  while ((m = voiceRe.exec(raw))) {
    const said = String(m[1] || '').trim();
    out.push({
      id: `out-${seq.n++}`,
      side: 'out',
      name: botName,
      text: said ? `[语音]${said}` : '[语音]',
      kind: 'voice',
    });
  }

  const stickerRe = /<sticker>([\s\S]*?)<\/sticker>/gi;
  while ((m = stickerRe.exec(raw))) {
    out.push({
      id: `out-${seq.n++}`,
      side: 'out',
      name: botName,
      text: `[表情包] ${String(m[1] || '').trim()}`,
      kind: 'sticker',
    });
  }

  const reactRe = /<react\b[^>]*emoji\s*=\s*"([^"]+)"[^>]*\/?>/gi;
  while ((m = reactRe.exec(raw))) {
    out.push({
      id: `out-${seq.n++}`,
      side: 'out',
      name: botName,
      text: `贴了表情 ${m[1]}`,
      kind: 'react',
    });
  }

  if (!out.length && !/<replies|/i.test(raw)) {
    const plain = raw.replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain) {
      out.push({
        id: `out-${seq.n++}`,
        side: 'out',
        name: botName,
        text: plain.slice(0, 500),
        kind: 'msg',
      });
    }
  }

  return out;
}

export function sessionToBubbles(session: SessionDetail | null | undefined): ChatBubble[] {
  const botName = String(session?.bot_card || session?.bot_nickname || '机器人').trim() || '机器人';
  const messages = Array.isArray(session?.messages) ? session!.messages! : [];
  const seq = { n: 1 };
  const bubbles: ChatBubble[] = [];
  const notesMap = collectImageNotesMap(messages);
  const attachedIds = new Set<string>();

  for (const msg of messages) {
    const role = String(msg.role || '').toLowerCase();
    const content = String(msg.content || '');
    if (!content.trim()) continue;

    if (role === 'assistant' || role === 'model' || role === 'ai') {
      bubbles.push(...parseAssistantChunk(content, botName, seq));
      continue;
    }

    if (role === 'user' || role === 'human') {
      if (/<compaction-summary>/i.test(content)) {
        bubbles.push({
          id: `sys-${seq.n++}`,
          side: 'sys',
          name: '系统',
          text: '（远史已压缩，以下为近史）',
          kind: 'compact',
        });
      }
      bubbles.push(...parseInboundChunk(content, seq, notesMap, attachedIds));
    }
  }

  for (const [mid] of notesMap) {
    if (attachedIds.has(mid)) continue;
    const notes = notesForMessage(notesMap, mid);
    if (!notes.length) continue;
    bubbles.push({
      id: `eyes-orphan-${seq.n++}`,
      side: 'sys',
      name: '识图',
      text: `msgid:${mid} · ${notes.join(' / ')}`,
      kind: 'eyes',
      messageId: mid,
      imageNotes: notes,
    });
  }

  return bubbles;
}

export function avatarLetter(name: string): string {
  const s = String(name || '').trim();
  return s ? s.slice(0, 1) : '?';
}

export function groupRoleLabel(role: ChatBubble['groupRole']): string {
  if (role === 'owner') return '群主';
  if (role === 'admin') return '管理';
  if (role === 'member') return '成员';
  return '';
}
