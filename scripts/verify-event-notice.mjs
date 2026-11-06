import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-event-'));
async function loadModule(relTsPath, name) {
    const outfile = path.join(tmpDir, `${name || path.basename(relTsPath, '.ts')}.cjs`);
    await build({
        entryPoints: [path.join(root, relTsPath)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        logLevel: 'silent',
        external: ['extract-zip'],
    });
    return createRequire(import.meta.url)(outfile);
}

const KAKA_ROOT = path.join('筱筱吖', '扩展功能', '智能对话');
const dataDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-event-data-'));
fs.mkdirSync(path.join(dataDir, KAKA_ROOT), { recursive: true });
fs.writeFileSync(
    path.join(dataDir, KAKA_ROOT, 'config.json'),
    JSON.stringify({
        vendor: 'x',
        model: 'x',
        base_url: '',
        debounce_ms: 3600000,
        web_search: { mcp_enabled: false },
    }),
);
fs.writeFileSync(path.join(dataDir, KAKA_ROOT, '群聊开关.json'), JSON.stringify({ 955682835: '开启' }));

const ingestMod = await loadModule('test/event-ingest-testable.ts', 'ingest');
ingestMod.setDataPath(dataDir);

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const deps = {
    readA: (f) => {
        try {
            return fs.readFileSync(path.join(dataDir, f), 'utf8');
        } catch {
            return '';
        }
    },
    writeA: (f, c) => {
        fs.mkdirSync(path.dirname(path.join(dataDir, f)), { recursive: true });
        fs.writeFileSync(path.join(dataDir, f), c);
        return true;
    },
    readB: (f, k, d) => {
        try {
            const o = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
            return o?.[k] ?? d;
        } catch {
            return d;
        }
    },
    writeB: (f, k, v) => {
        try {
            const p = path.join(dataDir, f);
            let o = {};
            try {
                o = JSON.parse(fs.readFileSync(p, 'utf8'));
            } catch { /* fresh */ }
            o[k] = v;
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(o));
            return true;
        } catch {
            return false;
        }
    },
    getDataPath: () => dataDir,
    logger: noopLogger,
    botApi: async () => ({ retcode: 0, data: null }),
};

const GROUP_ID = 955682835;
const SELF_ID = 3573995540;

function mkPoke(actor, target, actionTxt, suffix) {
    return {
        time: 1793400626,
        self_id: SELF_ID,
        post_type: 'notice',
        notice_type: 'notify',
        sub_type: 'poke',
        target_id: target,
        user_id: actor,
        group_id: GROUP_ID,
        raw_info: [
            { col: '1', nm: '', type: 'qq', uid: 'u_A' },
            { jp: 'https://x', src: 'https://x', type: 'img' },
            { txt: actionTxt || '戳了戳', type: 'nor' },
            { col: '1', nm: '', tp: '0', type: 'qq', uid: 'u_B' },
            { txt: suffix || '', type: 'nor' },
        ],
    };
}

function readBuffer() {
    const raw = fs.readFileSync(path.join(dataDir, KAKA_ROOT, 'buffer', `g_${GROUP_ID}.json`), 'utf8');
    return JSON.parse(raw).pending;
}

fs.mkdirSync(path.join(dataDir, KAKA_ROOT, 'buffer'), { recursive: true });
fs.writeFileSync(
    path.join(dataDir, KAKA_ROOT, 'buffer', `g_${GROUP_ID}.json`),
    JSON.stringify({ pending: [{ userId: '2010433365', nickname: '外界☆quiz', text: '铺垫一句', time: '2026-10-31 07:00:00', eventSnapshot: {} }] }),
);

const pokeMe = mkPoke(2010433365, SELF_ID, '揉了揉', '的下面，并说就这一次');
let ok = await ingestMod.smartChatIngestNotice(deps, pokeMe);
assert.strictEqual(ok, true, 'poke-to-bot 应被记录');
let buf = readBuffer();
const ev1 = buf[buf.length - 1];
assert.strictEqual(ev1.eventKind, 'poke', 'eventKind=poke');
assert.ok(ev1.text.includes('揉了揉'), `动作模板进正文: ${ev1.text}`);
assert.ok(ev1.text.includes('2010433365'), '发起者 QQ 在正文');
assert.ok(ev1.text.includes('3573995540'), `目标写明是 bot: ${ev1.text}`);
assert.ok(ev1.text.includes('拍的是你'), '被拍的是你标记');
assert.deepStrictEqual(ev1.atQqs, [String(SELF_ID)], 'poke-bot 指向本账号');
assert.ok(!ev1.messageId, '事件无 msgid');

const titleEv = {
    time: 1793400662,
    self_id: SELF_ID,
    post_type: 'notice',
    group_id: GROUP_ID,
    user_id: 2010433365,
    notice_type: 'notify',
    sub_type: 'title',
    title: '888刮刮',
};
ok = await ingestMod.smartChatIngestNotice(deps, titleEv);
assert.strictEqual(ok, true, 'title 事件应被记录');
buf = readBuffer();
const ev2 = buf[buf.length - 1];
assert.strictEqual(ev2.eventKind, 'title', 'eventKind=title');
assert.ok(ev2.text.includes('888刮刮'), `头衔内容在正文: ${ev2.text}`);
assert.ok(ev2.text.includes('2010433365'), '头衔归属人在正文');

const pokeOther = mkPoke(2010433365, 2071521294, '戳了戳', '');
ok = await ingestMod.smartChatIngestNotice(deps, pokeOther);
assert.strictEqual(ok, true, 'poke-other 应被记录');
buf = readBuffer();
const ev3 = buf[buf.length - 1];
assert.ok(!ev3.atQqs, '拍别人不指向本账号');
assert.ok(!/拍的是你/.test(ev3.text), '拍别人不带被拍标记');

const compose = await loadModule('src/auth/smart-chat-compose.ts');
const lines = compose.formatBatchLines([
    ev1,
    { userId: '2010433365', nickname: '外界☆quiz', text: '普通发言', time: '2026-10-31 07:01:00', messageId: '123', eventSnapshot: {} },
]);
const evLine = lines.split('\n')[0];
assert.ok(evLine.includes('[事件上报|拍一拍]'), `事件行带明确前缀: ${evLine}`);
assert.ok(!/外界☆quiz\(2010433365\)\s+\[msgid/.test(evLine), '事件行不得挂成发言格式');
const msgLine = lines.split('\n')[1];
assert.ok(/\[msgid:123\]/.test(msgLine), '普通消息行格式不变');

const guide = compose.buildEventGuideBlock([ev1, ev2]);
assert.ok(guide.includes('<event-guide>'), 'guide 壳');
assert.ok(guide.includes('拍一拍'), 'guide 含拍一拍语义');
assert.ok(guide.includes('群头衔'), 'guide 含群头衔语义');
assert.ok(guide.includes('不是任何人打的字'), 'guide 明确非发言');
assert.ok(guide.includes('没有拍回去的能力'), 'guide 教拍一拍能力边界');
assert.strictEqual(compose.buildEventGuideBlock([{ userId: '1', nickname: 'x', text: 't', time: 't', eventSnapshot: {} }]), '', '无事件时零注入');

const tg = compose.buildTalkGraph([ev1], String(SELF_ID), '沐沐沐沐');
assert.ok(!tg.text.includes('揉了揉'), '事件行不进关系图');

const types = await loadModule('src/auth/smart-chat-types.ts');
const stripped = types.stripHostPanelBlocks('<event-guide>\n拍一拍说明\n</event-guide>\n正文保留');
assert.ok(!stripped.includes('<event-guide>'), 'digest 折叠时剥事件理解段');
assert.ok(stripped.includes('正文保留'), '其余正文不受影响');

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('verify-event-notice: all passed');
