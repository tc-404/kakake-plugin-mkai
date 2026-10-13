// @ts-nocheck
// ---------------------------------------------------------------------------
// MKAPI 工具技能 — 类型
// ---------------------------------------------------------------------------

export interface MkApiCall {
    /** 工具代号，如 001 */
    code: string;
    /** 原始属性表 */
    attrs: Record<string, string>;
    /** 原文片段 */
    raw: string;
}

export interface MkApiToolDef {
    code: string;
    /** 展示名 */
    title: string;
    /** 何时用 / 要什么参数（给 AI 看的短说明） */
    when: string;
    /** 参数说明 */
    params: string;
    /** 后台是否默认允许 */
    defaultEnabled?: boolean;
    /**
     * 原生 function-calling 的 JSON Schema（省略则按「只要 group_id」处理）。
     * 同一个工具靠不同参数得到不同结果时，务必在这里声明清楚。
     */
    schema?: Record<string, unknown>;
    /** 给模型看的 MKAPI 标签写法示例（省略则用 group_id 示例） */
    example?: string;
    /** 执行体 */
    run: (ctx: MkApiRunContext, call: MkApiCall) => Promise<MkApiRunResult>;
}

/** 群文件桥：由宿主按当前会话构造，锁死在本群的专属文件夹内（只读不执行） */
export interface MkApiFileBridge {
    /** 落盘子目录（群号）；私聊为空 */
    scopeId: string;
    /** 是否可用（群聊 + 拿到群号） */
    available: boolean;
    /** 后台「识别文件」开关是否开启（关闭时只提示，不读盘） */
    enabled?: boolean;
    /** 展示用相对目录，如 群文件/1082631686 */
    dirLabel: string;
    allowedExts: string[];
    list: (limit?: number) => Array<{ name: string; rel: string; size: number; mtime: number }>;
    read: (name: string, offset?: number, limit?: number) => {
        ok: boolean;
        name?: string;
        rel?: string;
        text?: string;
        total?: number;
        offset?: number;
        next?: number | null;
        error?: string;
    };
    send: (name: string) => Promise<{ ok: boolean; via?: string; name?: string; error?: string }>;
}

export interface MkApiRunContext {
    botApi?: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
    logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
    /** 技能树开关：false 时按「查无」处理 */
    isToolEnabled: (code: string) => boolean;
    /** 群文件读取/发送桥（002 号工具用；私聊或未开识别文件时不可用） */
    file?: MkApiFileBridge | null;
}

export interface MkApiRunResult {
    ok: boolean;
    /** 给模型续写用的纯文本要点 */
    text: string;
}
