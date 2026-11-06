import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.mkai-verify-pet-'));
async function loadModule(relTsPath) {
    const outfile = path.join(tmpDir, `${path.basename(relTsPath, '.ts')}.cjs`);
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

const safety = await loadModule('src/auth/smart-chat-safety.ts');
const mk = (t, sticker) => ({ type: 'msg', text: t, sticker });

const r1 = safety.deflangePetPhrases([mk('哼，要看我存货啊'), mk('略略略，你家猫抢饭碗'), mk('这话说的，我服了')]);
assert.strictEqual(r1.trimmed, 1, `case1 trimmed=${r1.trimmed}`);
assert.strictEqual(r1.actions[0].text, '哼，要看我存货啊', '第一条贴片保留');
assert.strictEqual(r1.actions[1].text, '你家猫抢饭碗', '后续贴片削去');
assert.strictEqual(r1.actions[2].text, '这话说的，我服了', '无贴片不动');

const r2 = safety.deflangePetPhrases([mk('就这点，哼')]);
assert.strictEqual(r2.trimmed, 0, '单条单贴片不干预');

const r3 = safety.deflangePetPhrases([mk('猫：我只是踩了一下'), mk('说真的没点开看')]);
assert.strictEqual(r3.trimmed, 0, '无贴片不干预');

const r4 = safety.deflangePetPhrases([mk('略略略'), mk('切，随便你'), mk('哼')]);
assert.strictEqual(r4.actions.length, 2, `全贴片短句削后空条删除，剩余 ${r4.actions.length}`);
assert.strictEqual(r4.actions[0].text, '略略略', '配额内第一条保留');
assert.strictEqual(r4.actions[1].text, '随便你', '第二条贴片削去但内容保留');
assert.ok(r4.trimmed >= 2, `case4 trimmed=${r4.trimmed}`);

const r5 = safety.deflangePetPhrases([mk('确实好看'), mk('略略略，你家猫抢饭碗', '菲比/1.webp')]);
assert.strictEqual(r5.trimmed, 0, '带贴图的 msg 不参与削峰');

const types = await loadModule('src/auth/smart-chat-types.ts');
assert.ok(!types.DEFAULT_PERSONA_LINE.includes('略略略'), '默认人设不得再点名语气词');
assert.ok(types.DEFAULT_PERSONA_LINE.includes('情绪真的满了'), '人设改为情绪驱动表述');

const pack = JSON.parse(fs.readFileSync(path.join(root, 'src/auth/style-packs/groupie.json'), 'utf8'));
const tone = pack.examples.find((e) => e.situation === '语气词');
assert.ok(tone && /一轮最多带一个|情绪满了/.test(tone.say), '风格包含语气词分寸条');

const flushSrc = fs.readFileSync(path.join(root, 'src/auth/smart-chat-flush.ts'), 'utf8');
assert.ok(flushSrc.includes('deflangePetPhrases'), 'flush 已接入削峰');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('verify-pet-phrases: all passed');
