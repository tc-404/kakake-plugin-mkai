// @ts-nocheck
// ---------------------------------------------------------------------------
// MKAPI — 注册表 / 解析 / 排队执行 / 给模型的短说明
// ---------------------------------------------------------------------------

import type { MkApiCall, MkApiRunContext, MkApiToolDef } from './types.js';
import { tool001GroupDetail } from './001-group-detail.js';
import { tool002GroupFile } from './002-group-file.js';

export const MK_API_TOOLS: MkApiToolDef[] = [tool001GroupDetail, tool002GroupFile];

const TOOL_BY_CODE = new Map(MK_API_TOOLS.map((t) => [t.code, t]));

export function listMkApiToolDefs(): MkApiToolDef[] {
    return [...MK_API_TOOLS];
}

export function getMkApiTool(code: string): MkApiToolDef | undefined {
    return TOOL_BY_CODE.get(String(code || '').trim());
}

/** 解析助手正文里的 <MKAPI …/> / <MKAPI …></MKAPI> */
export function parseMkApiCalls(content: string): MkApiCall[] {
    const raw = String(content || '');
    if (!raw || !/<MKAPI\b/i.test(raw)) return [];
    const out: MkApiCall[] = [];
    const re = /<MKAPI\b([^>]*)\s*(?:\/>|>([\s\S]*?)<\/MKAPI\s*>)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
        const attrBlob = String(m[1] || '');
        const attrs: Record<string, string> = {};
        const attrRe = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"|([a-zA-Z_][\w-]*)\s*=\s*'([^']*)'|([a-zA-Z_][\w-]*)\s*=\s*([^\s"'>/]+)/g;
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(attrBlob))) {
            const key = String(am[1] || am[3] || am[5] || '').trim();
            const val = String(am[2] ?? am[4] ?? am[6] ?? '').trim();
            if (key) attrs[key] = val;
        }
        const code = String(attrs.code || attrs.id || '').trim();
        if (!code) continue;
        out.push({ code, attrs, raw: m[0] });
    }
    return out;
}

export function stripMkApiTags(content: string): string {
    return String(content || '')
        .replace(/<MKAPI\b[^>]*\s*(?:\/>|>[\s\S]*?<\/MKAPI\s*>)/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function contentHasMkApi(content: string): boolean {
    return parseMkApiCalls(content).length > 0;
}

/** 全局串行队列：脚本工具执行期间后来的调用排队 */
let mkApiQueue: Promise<void> = Promise.resolve();

export function enqueueMkApiTask<T>(task: () => Promise<T>): Promise<T> {
    const run = mkApiQueue.then(task, task);
    mkApiQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export async function executeMkApiCalls(
    ctx: MkApiRunContext,
    calls: MkApiCall[],
): Promise<string> {
    if (!calls.length) return '';
    const blocks: string[] = [];
    for (const call of calls) {
        const tool = getMkApiTool(call.code);
        const result = await enqueueMkApiTask(async () => {
            if (!tool) {
                return { ok: false, text: `未知工具代号：${call.code}` };
            }
            try {
                return await tool.run(ctx, call);
            } catch (e) {
                ctx.logger?.error?.(`[MKAPI:${call.code}] 执行失败:`, e);
                return { ok: false, text: `工具 ${call.code} 执行异常：${(e as Error)?.message || e}` };
            }
        });
        blocks.push(
            `<mkapi-result code="${call.code}" ok="${result.ok ? '1' : '0'}">\n${result.text}\n</mkapi-result>`,
        );
    }
    return (
        '以下是宿主执行 MKAPI 的结果（私下查到的素材，不是群友发言）。'
        + '用群友口吻随口说一两句有用的就行，别念报表、别报「群号/人数」字段清单；'
        + '不要复读标签，不要假装没查过。若结果为查无/失败，如实说查不到或装傻带过即可。\n'
        + '结果里出现 \u003cfile\u003e…\u003c/file\u003e 的，是宿主帮你读出来的文件正文（只读不运行）：'
        + '可以据此回答问题、指出问题在哪，但别整份复读代码、别假装自己跑过它。\n'
        + blocks.join('\n')
    );
}

/** OpenAI function tools：与 web_search 同级挂载，模型用 tool_calls 调用 */
export function buildMkApiOpenAiTools(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
    const fallbackSchema = {
        type: 'object',
        properties: {
            group_id: {
                type: 'string',
                description: 'QQ 群号数字',
            },
        },
        required: ['group_id'],
    };
    return MK_API_TOOLS.map((t) => ({
        type: 'function' as const,
        function: {
            name: `mkapi_${t.code}`,
            description:
                `${t.title}（宿主本地脚本，优先于 web_search）。${t.when}。参数：${t.params}`,
            parameters: (t.schema && typeof t.schema === 'object' ? t.schema : fallbackSchema) as Record<string, unknown>,
        },
    }));
}

/** 解析 function name / 伪名 MKAPI → 代号 */
export function resolveMkApiToolCode(name: string, args?: Record<string, unknown>): string {
    const n = String(name || '').trim();
    const m = /^mkapi[_-]?(\d+)$/i.exec(n);
    if (m) return m[1];
    if (/^mkapi$/i.test(n) || n === 'MKAPI') {
        const fromArgs = String(args?.code ?? args?.id ?? '').trim();
        if (fromArgs) return fromArgs;
        // 误把「MKAPI」当函数名：按参数猜代号（op/文件名 → 群文件；只有群号 → 查群）
        if (String(args?.op ?? args?.name ?? args?.file ?? '').trim()) return '002';
        if (String(args?.group_id ?? args?.groupId ?? '').trim()) return '001';
        return '';
    }
    return '';
}

/** 执行一条原生 tool_call（mkapi_001 / 误名 MKAPI） */
export async function executeMkApiFunctionCall(
    ctx: MkApiRunContext,
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    const code = resolveMkApiToolCode(name, args);
    if (!code) {
        return JSON.stringify({
            error: 'unknown_mkapi',
            message:
                `无法识别脚本工具「${name}」。查 QQ 群请调用 mkapi_001（参数 group_id）；`
                + '群文件请调用 mkapi_002（参数 op=list|read|send，name=文件名）。',
        });
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(args || {})) {
        if (v == null) continue;
        attrs[k] = String(v).trim();
    }
    if (!attrs.group_id && attrs.groupId) attrs.group_id = attrs.groupId;
    const blocks = await executeMkApiCalls(ctx, [{ code, attrs, raw: '' }]);
    // tool 角色只要结果正文；去掉外层教模型的 user 话术壳
    const m = /<mkapi-result\b[^>]*>\s*([\s\S]*?)\s*<\/mkapi-result>/i.exec(blocks);
    const text = m ? String(m[1] || '').trim() : blocks;
    return JSON.stringify({ code, text });
}

/** 稳定挂到 system：让模型知道可调用哪些脚本工具（开关不删知识，只挡后端） */
export function buildMkApiSystemSuffix(): string {
    const lines = MK_API_TOOLS.map((t) => (
        `◆ mkapi_${t.code}（${t.title}）\n`
        + `  何时：${t.when}\n`
        + `  参数：${t.params}\n`
        + `  优先：原生 tool_calls 调 mkapi_${t.code}；也可写 ${t.example || `<MKAPI code="${t.code}" group_id="群号"/>`}`
    ));
    return (
        '\n\n[工具技能 · MKAPI]\n'
        + '这是宿主脚本工具（OneBot/本地接口），优先级高于「联网 web_search」。\n'
        + '调用任何工具前先心里排：①脚本工具能否解决？能 → 只调 mkapi_*，禁止 web_search；②脚本解决不了的公网事实 → 再 web_search/web_fetch；③闲聊接梗 → 都不调。\n'
        + '查 QQ 群号/群资料/群是否存在：必须 mkapi_001，禁止用 web_search 搜群号，也禁止空口编「去客户端查找」。\n'
        + '群里传过的文件：只能靠 mkapi_002 看内容或重新发出来；宿主只帮你读字，不会运行任何文件，你也别声称自己运行过。\n'
        + '对话里出现「[文件 msgid:N 宿主读取]: …」的行，是宿主读出来的文件正文，不是群友打的字；太大/没加载的文件只会给到名字和位置，要正文就调 mkapi_002 op="read"。\n'
        + '禁止把「MKAPI」当成函数名乱调——要用 mkapi_001 这种具体名字。\n'
        + '要调脚本/等回灌时：必须同轮带一句很短的 <status>说明下一步；群里可说可不说。调了就等 tool/<mkapi-result> 再 <replies>；禁止空口说「我去查了」却不调。\n'
        + '同一轮可调多个；闲聊接梗别无故刷。\n'
        + '\n'
        + lines.join('\n')
        + '\n'
    );
}
