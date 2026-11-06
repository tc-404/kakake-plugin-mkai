import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'scripts', 'corpus-src');
const outFile = path.join(root, 'src', 'auth', 'slang-corpus.json');

const SOURCES = [
    { file: '01_cheer_terms.jsonl', tag: 'buzzword' },
    { file: '04_vbar.jsonl', tag: 'vbar' },
    { file: 'supplement.jsonl', tag: 'supplement' },
];

function parseChunkText(text) {
    const t = String(text || '').replace(/\r/g, '');
    const grab = (re) => {
        const m = t.match(re);
        return m ? m[1].trim() : '';
    };
    const term = grab(/【词条】\s*([^\n]+)/);
    const brief = grab(/【释义】\s*([\s\S]*?)(?=\n【|$)/);
    const detail = grab(/【详解】\s*([\s\S]*?)(?=\n【|$)/);
    const scene = grab(/【出处\/语境】\s*([\s\S]*?)(?=\n【|$)/);
    return { term, brief, detail, scene };
}

function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

const entries = [];
const seen = new Set();
let skippedNoTerm = 0;

for (const src of SOURCES) {
    const raw = fs.readFileSync(path.join(srcDir, src.file), 'utf8');
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            continue;
        }
        const { term, brief, detail, scene } = parseChunkText(row?.text);
        if (!term) {
            skippedNoTerm += 1;
            continue;
        }
        const name = term.split(/\s+/)[0].slice(0, 24);
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const parts = [clip(brief, 220)];
        if (detail) parts.push(clip(detail, 160));
        if (scene) parts.push(`语境：${clip(scene, 80)}`);
        const def = parts.filter(Boolean).join('\n');
        if (!def) continue;
        const keys = new Set([name]);
        for (const seg of String(name).match(/[A-Za-z0-9]{2,}/g) || []) {
            keys.add(seg.toLowerCase());
        }
        const isBoundary = [...name].length <= 1;
        if (isBoundary) keys.delete(name);
        entries.push({
            t: name,
            k: [...keys],
            d: def,
            s: src.tag,
            ...(isBoundary ? { b: 1 } : {}),
        });
    }
}

entries.sort((a, b) => a.t.localeCompare(b.t, 'zh-CN'));
const out = {
    version: 2,
    built_at: new Date().toISOString(),
    source: 'NooBlock/astrbot-rag-kb corpora/01_cheer_terms + corpora/04_vbar + supplement',
    count: entries.length,
    entries,
};
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`built ${out.count} entries, bytes=${fs.statSync(outFile).size}`);
