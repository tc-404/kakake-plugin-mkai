// @ts-nocheck
import slangCorpus from './slang-corpus.json';
import type { SmartChatKnowledgeEntry } from './smart-chat-types';

interface SlangRow {
    t: string;
    k: string[];
    d: string;
    s: string;
    b?: number;
}

const rawRows: SlangRow[] = Array.isArray((slangCorpus as any)?.entries)
    ? (slangCorpus as any).entries
    : [];

function escapeRe(s: string): string {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ReadyRow {
    row: SlangRow;
    plainKeys: string[];
    boundary: RegExp | null;
}

const readyRows: ReadyRow[] = [];
for (const row of rawRows) {
    const name = String(row?.t || '').trim();
    const def = String(row?.d || '').trim();
    if (def.length < 8) continue;
    if (name.length < 2 && !row?.b) continue;
    const keys = (Array.isArray(row?.k) ? row.k : [])
        .map((k) => String(k || '').trim().toLowerCase())
        .filter((k) => k.length >= 2);
    let boundary: RegExp | null = null;
    if (row?.b) {
        try {
            boundary = new RegExp(`(^|[^\\u4e00-\\u9fa5A-Za-z0-9])${escapeRe(name.toLowerCase())}($|[^\\u4e00-\\u9fa5A-Za-z0-9])`);
        } catch {
            boundary = null;
        }
    }
    if (!keys.length && !boundary) continue;
    readyRows.push({ row, plainKeys: keys, boundary });
}

export const SLANG_CORPUS_VERSION = Number((slangCorpus as any)?.version) || 0;
export const SLANG_CORPUS_COUNT = readyRows.length;

export function selectSlangByHits(queryText: string, maxEntries = 6): SmartChatKnowledgeEntry[] {
    const limit = Math.max(0, Math.floor(Number(maxEntries) || 0));
    const blob = String(queryText || '').toLowerCase();
    if (!limit || !blob.trim() || !readyRows.length) return [];
    const hits: SmartChatKnowledgeEntry[] = [];
    const seen = new Set<string>();
    for (const { row, plainKeys, boundary } of readyRows) {
        if (hits.length >= limit) break;
        if (seen.has(row.t)) continue;
        const matched = plainKeys.some((k) => blob.includes(k))
            || (boundary ? boundary.test(blob) : false);
        if (!matched) continue;
        seen.add(row.t);
        hits.push({
            id: `slang_${String(row.s || 'x')}_${row.t}`,
            title: `黑话「${row.t}」`,
            content: row.d,
            tags: ['黑话', String(row.s || '')],
            enabled: true,
            updated_at: '',
            kind: 'lore',
            keys: row.k,
            priority: 0,
        });
    }
    return hits;
}
