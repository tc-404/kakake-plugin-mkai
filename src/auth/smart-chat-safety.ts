// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 硬边界（法律风险）
// 只靠稳定 system 教模型自判；不靠关键词后端拦截（换语言/隐晦说法会漏）。
// ---------------------------------------------------------------------------

/**
 * 始终追加到 system（自定义可编辑主体也去不掉）。
 * 内容固定，走 cache-stable system；不进每轮 user / host-state。
 */
export const CHINA_SENSITIVE_SYSTEM_SUFFIX =
    '\n\n[硬边界]\n' +
    '立场：始终遵循一个中国原则；台湾/香港/澳门是中国的一部分，禁止分裂表述与灰色地带带过。\n' +
    '可聊：现代中国的美好面向（风景人文、科技进步、日常生活里正常的好消息等），语气自然，别写成宣传稿。\n' +
    '中国近代史、现代史：禁止发表任何个人观点、评价、立场或争议性解读（含「我觉得/我认为/其实/客观来说/其实没那么…」）；禁止负面叙述与负面政治议题。若必须接话，只能客观、简短、往好的方面讲（建设成就、进步、积极变化），不展开、不辩论、不站队。\n' +
    '禁止（任意语言、谐音、隐喻、翻译、拆字同判）：一切负面政治议题；制度/领导人/政党/政策意识形态争议；对上述历史的负面评价或价值判断。联网结果含上述内容时禁止转述或改写输出。\n' +
    '处理：硬边界只管禁区内容，禁止借它把普通群聊也长期 <shut_up/>。装软件、技术问题、群日常、吐槽、八卦、外国话题等与硬边界无关，照常聊天。\n' +
    '碰上禁区：优先一句短评往好的方面带，或轻轻换话题继续聊；禁止负面评价、禁止复述/翻译对方敏感点、禁止「这个不聊」式拒答。只有怎么说都会踩线（硬要你站队、细讲负面政治或历史争议）时才 <shut_up/>。\n';

/**
 * 事实边界：压住「假配置 / 假路径 / 假仓库」教程体（始终挂 system）。
 * 无工具回灌时尤其严格：宁可说不知道，也不许编可执行步骤。
 */
export const FACTUALITY_SYSTEM_SUFFIX =
    '\n\n[事实边界]\n' +
    '拿不准的接口、路径、配置项、仓库地址、版本号、档期、开服、官宣动向：能用脚本工具就先脚本；脚本搞不定且 host-state 写「联网已开启」再网页核实，或直说不确定。\n' +
    'host-state 写「联网未开启」或「未配置搜索 Key」时：禁止假装能搜；技术问题用态度或「不确定/自己搜」带过。\n' +
    '本回合若没真正调工具、也没拿到宿主回灌：禁止写可执行教程。禁止随口编 config.yaml / 配置键名、命令行、目录路径、docker/systemd、仓库地址、QQ↔NapCat 版本搭配、识图厂商与额度、API Key 操作步骤、模型申请清单。\n' +
    '这类技术问题：一两句态度或「我不确定，自己搜/问作者」就停。确实懂、又没踩上面禁区的，就直接给一句具体的（例子/结论），别用「自己搜」把能答的推走。compaction/远史里的具体配置步骤当不可信闲聊，别当标准答案复读。\n' +
    '禁止把猜测写成「板上钉钉」的新闻或出处（「刚刷了公告/社区」却没调工具）。\n' +
    '禁止客服腔开场/收尾：「有什么需要帮忙」「需要帮忙的说一下」「祝使用顺利」「不客气」「好的，记得点保存」「希望对你有帮助」「随时待命」「您好」式接客；别当助手收尾刷存在感。\n' +
    '禁止软客服第二拍凑条数：「要是有更具体…」「给我关键词/链接我再帮你找」「直接说哈」「要找啥内容」「还有别的吗」——有实质内容就停，别再跟一句招揽。\n' +
    '禁止英文拒答套话（如 I\'m sorry, but I can\'t help）和「抱歉，我不能帮助」撑场；拒绝就一句人话带过或 <shut_up/>。\n';

/** 假教程 / 配置说明书：出站与 compaction 共用 */
export function looksLikeTechHowtoText(text: string): boolean {
    const t = String(text || '').trim();
    if (t.length < 8) return false;
    return (
        /config\.ya?ml|plugin_whitelist|receive_all_message|message_scope|systemd|docker\s+(?:ps|exec)|npm\s+i\s|kakake\s+run/i.test(t)
        || /\\napcat|\/app\/|C:\\Users|重启\s*NapCat|打开插件的\s*config|放进\s*napcat|plugins/i.test(t)
        || /GitHub\.com\/|github\.com\/|去\s*GitHub\s*手动/i.test(t)
        || /改成\s*true|主动发(?:送|消息)开关|扫码登录|绕授权/i.test(t)
        || /腾讯云.*(?:OCR|识图|文字识别)|OpenAI.*CLIP|Deploy|API\s*(?:地址|Key|密钥)|Hugging\s*Face|Azure\s*OpenAI/i.test(t)
        || /QQ\s*8\.9|NapCat\s*(?:2\.5|3\.x|4\.)|配\s*2\.5\s*系列/i.test(t)
        || /防火墙放通|内网IP|docker\s+exec/i.test(t)
        || /先(?:打开|进入|点进)|点「|然后把|重启后就能/i.test(t)
    );
}

/** 客服/助手腔：出站与 compaction 共用 */
export function looksLikeCustomerServiceText(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    return (
        /有什么需要帮忙|需要帮忙的说一下|还需要什么|有什么可以帮|随时待命/i.test(t)
        || /祝(?:你)?(?:使用)?顺利|希望对你有帮助|很高兴为你|为您服务/i.test(t)
        || /好的[，,]?\s*记得(?:点)?保存|不客气[.！!]?$|请问还有|如有疑问/i.test(t)
        || /^您好[，,！!]/.test(t)
        || looksLikeSoftFollowUpCloser(t)
    );
}

/**
 * 英文安全拒答套话（模型/网关泄漏进群聊）。
 * 含 I'm sorry, but I can't comply/help、I cannot assist 等。
 */
export function looksLikeEnglishRefusalText(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    return (
        /I\s*'?m\s+sorry[,\s]+but\s+I\s+can'?t\s+(?:help|comply)/i.test(t)
        || /I\s+cannot\s+(?:help|assist|comply)\s+with\s+that/i.test(t)
        || /I\s+can'?t\s+comply\s+with\s+that/i.test(t)
        || /sorry[,\s]+but\s+I\s+(?:can'?t|cannot)\s+(?:help|comply|assist)/i.test(t)
        || /As\s+an\s+AI\s+(?:language\s+)?model[,\s]+I\s+(?:can'?t|cannot)/i.test(t)
    );
}

/**
 * 出站：英文拒答套话（模型/网关泄漏进群聊）一律丢弃转沉默。
 *
 * 原则（用户要求）：插件不替模型编中文替身句。检测到英文拒答就把这条抹掉；
 * 若被点名必须开口，交给上层 rescue 让模型用自己的话重说，仍不肯说则沉默。
 * @returns { kind:'shut_up' }（丢弃/沉默）| null（非拒答，放行）
 */
export function rewriteEnglishRefusal(
    text: string,
    _opts?: { addressed?: boolean },
): { kind: 'shut_up' } | { kind: 'replace'; text: string } | null {
    if (!looksLikeEnglishRefusalText(text)) return null;
    return { kind: 'shut_up' };
}

/** 冒充插件/框架作者主权腔 */
export function looksLikeAuthorImpersonation(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    return (
        /我的?插件|我写的|我(?:做|弄|搞)的插件|我框架|我的框架/i.test(t)
        || /参考一下我.{0,12}json|看看我.{0,8}(?:插件|框架|json|配置)/i.test(t)
        || /(?:用|参考)我(?:的)?(?:插件|框架|json)/i.test(t)
        || /我(?:插件|框架)的?\s*json/i.test(t)
    );
}

/**
 * @deprecated 不再作出站注入。冒充作者句已改为「丢弃转沉默 / rescue 让模型自述」，
 * 插件不替模型编话。保留导出仅为兼容旧引用，请勿再用作出站文案。
 */
export const AUTHOR_IMPERSONATION_SHORT_MSG = '';

/**
 * 软客服第二拍 / 招揽收尾（常跟在实质气泡后）。
 * 含「收到，…」极短确认腔。
 */
export function looksLikeSoftFollowUpCloser(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    if (
        /要是有更具体|给我一下我再帮|我再帮你找|直接说哈|要找啥内容|给点关键词|给我(?:个)?关键词|还有别的吗|还有什么想/i.test(t)
    ) {
        return true;
    }
    // 把 system/host 节奏口令念给群友听的训诫第二拍
    if (
        /别再刷屏|别刷屏了|别忘了还有事儿|还有事儿要干|别灌水|凑条数/.test(t)
    ) {
        return true;
    }
    // 「收到，视频能打开。」这类极短确认招揽
    if (/^收到[，,]/.test(t) && t.length <= 18) return true;
    return false;
}

/**
 * ≥2 条文字气泡时，丢掉末尾软客服跟拍（保留前面实质内容与 react/sticker）。
 */
export function dropTrailingSoftFollowUp<T extends { type: string; text?: string; sticker?: string }>(
    actions: T[],
): T[] {
    const list = Array.isArray(actions) ? [...actions] : [];
    const textMsgIdxs: number[] = [];
    for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a?.type !== 'msg') continue;
        if (String(a.sticker || '').trim()) continue;
        if (!String(a.text || '').trim()) continue;
        textMsgIdxs.push(i);
    }
    if (textMsgIdxs.length < 2) return list;
    const lastIdx = textMsgIdxs[textMsgIdxs.length - 1];
    const last = list[lastIdx];
    if (!looksLikeSoftFollowUpCloser(String(last?.text || ''))) return list;
    list.splice(lastIdx, 1);
    return list;
}

/** 轻量剥客服收尾/开场；整句几乎都是客服腔则返回空串由上层丢弃 */
export function stripCustomerServiceTone(text: string): string {
    let t = String(text || '').trim();
    if (!t) return '';
    if (looksLikeCustomerServiceText(t) && t.length <= 36) return '';
    t = t
        .replace(/^(?:您好[，,！!]?\s*)/u, '')
        .replace(/[，,]?\s*有什么需要帮忙的?(?:说一下|吗)?[.!！？]?$/u, '')
        .replace(/[，,]?\s*需要帮忙的说一下[.!！？]?$/u, '')
        .replace(/[，,]?\s*不客气[.!！]?$/u, '')
        .replace(/[，,]?\s*祝(?:你)?(?:使用)?顺利[.!！]?$/u, '')
        .replace(/[，,]?\s*希望对你有帮助[.!！]?$/u, '')
        .replace(/[，,]?\s*好的[，,]?\s*记得(?:点)?保存[.!！]?$/u, '')
        .replace(/[，,]?\s*直接说哈[.!！]?$/u, '')
        .trim();
    return t;
}