import { jsxs as o, jsx as e, Fragment as ne } from "react/jsx-runtime";
import { useState as v, useEffect as q, useRef as j, useCallback as E, useLayoutEffect as _i, createContext as La, useMemo as Z, useContext as Ra } from "react";
import { createPortal as ke } from "react-dom";
function yi(a, i) {
  const t = a.replace(/\/$/, "") + "/mkai";
  async function n(l) {
    if (!l.ok) {
      const u = await l.text().catch(() => "");
      throw new Error(`HTTP ${l.status}${u ? ` - ${u}` : ""}`);
    }
    return await l.json();
  }
  return {
    base: t,
    async get(l, u, d) {
      const m = new URLSearchParams();
      if (u)
        for (const [x, k] of Object.entries(u))
          k === void 0 || k === "" || m.set(x, String(k));
      const c = m.toString(), r = t + l + (c ? `?${c}` : "");
      return n(await i(r, { credentials: "include", ...d }));
    },
    async post(l, u, d) {
      return n(
        await i(t + l, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...d?.headers || {} },
          body: JSON.stringify(u ?? {}),
          ...d
        })
      );
    }
  };
}
const Pa = "(max-width: 760px)", Ia = "(pointer: coarse)", Aa = "(pointer: fine)";
function qa() {
  return typeof window < "u" && typeof window.matchMedia == "function";
}
function pa() {
  if (!qa()) return "desktop";
  const a = window.matchMedia(Pa).matches, i = window.matchMedia(Ia).matches, t = window.matchMedia(Aa).matches;
  return a || i && !t ? "mobile" : "desktop";
}
function Ke() {
  const [a, i] = v(pa);
  return q(() => {
    if (!qa()) return;
    const t = [Pa, Ia, Aa].map((l) => window.matchMedia(l)), n = () => i(pa());
    return t.forEach((l) => l.addEventListener("change", n)), n(), () => t.forEach((l) => l.removeEventListener("change", n));
  }, []), a;
}
function je(a, i, t) {
  const n = j(null), l = j([]), [u, d] = v({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    ready: !1
  }), m = E((r, x) => {
    l.current[r] = x;
  }, []), c = E(() => {
    const r = n.current, x = l.current[a];
    if (!r || !x) return;
    const k = r.getBoundingClientRect(), h = x.getBoundingClientRect();
    d({
      top: h.top - k.top + r.scrollTop,
      left: h.left - k.left + r.scrollLeft,
      width: h.width,
      height: h.height,
      ready: !0
    });
  }, [a]);
  return _i(() => {
    l.current.length < i && (l.current.length = i), c();
  }, [c, i, a, t]), q(() => {
    const r = n.current;
    if (!r) return;
    const x = new ResizeObserver(() => c());
    x.observe(r);
    for (const k of l.current)
      k && x.observe(k);
    return window.addEventListener("resize", c), r.addEventListener("scroll", c, { passive: !0 }), () => {
      x.disconnect(), window.removeEventListener("resize", c), r.removeEventListener("scroll", c);
    };
  }, [c, i, t]), { navRef: n, setItemRef: m, box: u };
}
function wi({
  api: a,
  toast: i,
  confirm: t
}) {
  const [n, l] = v("group"), [u, d] = v([]), [m, c] = v(""), [r, x] = v(!0), k = j(i);
  k.current = i;
  const h = E(async () => {
    x(!0);
    try {
      const p = await a.get("/smart-chat/blacklist", { type: n });
      if (p.code !== 0) throw new Error(p.message || "加载失败");
      d(p.data?.ids || []);
    } catch (p) {
      k.current(p instanceof Error ? p.message : String(p)), d([]);
    } finally {
      x(!1);
    }
  }, [a, n]);
  q(() => {
    h();
  }, [h]);
  const y = E(async () => {
    const p = m.split(/[,，\s\n]+/).map((g) => g.trim()).filter((g) => /^\d{5,15}$/.test(g));
    if (!p.length) {
      i("请输入有效 QQ 号/群号（5～15 位数字）", "warn");
      return;
    }
    try {
      const g = await a.post("/smart-chat/blacklist", {
        type: n,
        action: "add",
        ids: p
      });
      if (g.code !== 0) throw new Error(g.message || "添加失败");
      d(g.data?.ids || []), c(""), i(`已加入 ${p.length} 个黑户`, "ok");
    } catch (g) {
      i(g instanceof Error ? g.message : String(g), "err");
    }
  }, [a, m, n, i]), s = E(
    async (p) => {
      if (await t({
        title: "移除黑户",
        message: `确定将 ${p} 移出黑户？`,
        danger: !0,
        okText: "移除"
      }))
        try {
          const _ = await a.post("/smart-chat/blacklist", {
            type: n,
            action: "remove",
            ids: [p]
          });
          if (_.code !== 0) throw new Error(_.message || "移除失败");
          d(_.data?.ids || []), i("已移除", "ok");
        } catch (_) {
          i(_ instanceof Error ? _.message : String(_), "err");
        }
    },
    [a, t, n, i]
  );
  return { tab: n, setTab: l, ids: u, input: m, setInput: c, loading: r, reload: h, addIds: y, removeId: s };
}
function Ni({
  api: a,
  toast: i,
  confirm: t
}) {
  const n = wi({ api: a, toast: i, confirm: t }), l = n.tab === "group" ? 0 : 1, u = je(l, 2, n.tab);
  return /* @__PURE__ */ o("section", { className: "mkai-page-blacklist", children: [
    /* @__PURE__ */ e("div", { className: "sw-tabbar stagger-item stagger-2", children: /* @__PURE__ */ o("div", { className: "seg seg--center", ref: u.navRef, children: [
      /* @__PURE__ */ e(
        "div",
        {
          className: `nav-liquid${u.box.ready ? " is-ready" : ""}`,
          style: {
            transform: `translate3d(${u.box.left}px, ${u.box.top}px, 0)`,
            width: u.box.width,
            height: u.box.height
          },
          "aria-hidden": !0
        }
      ),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          ref: (d) => u.setItemRef(0, d),
          className: `seg__btn${n.tab === "group" ? " is-active" : ""}`,
          onClick: () => n.setTab("group"),
          children: "群聊"
        }
      ),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          ref: (d) => u.setItemRef(1, d),
          className: `seg__btn${n.tab === "user" ? " is-active" : ""}`,
          onClick: () => n.setTab("user"),
          children: "用户"
        }
      )
    ] }) }),
    /* @__PURE__ */ e("div", { className: "panel stagger-item stagger-3", children: /* @__PURE__ */ o("div", { className: "bl-add-row", children: [
      /* @__PURE__ */ e(
        "input",
        {
          className: "mk-input",
          placeholder: n.tab === "group" ? "输入群号，多个用空格或逗号分隔" : "输入 QQ 号，多个用空格或逗号分隔",
          value: n.input,
          onChange: (d) => n.setInput(d.target.value),
          onKeyDown: (d) => {
            d.key === "Enter" && (d.preventDefault(), n.addIds());
          },
          autoComplete: "off"
        }
      ),
      /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", onClick: () => void n.addIds(), children: "添加" })
    ] }) }),
    /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-4", children: [
      /* @__PURE__ */ o("h2", { className: "panel-title", children: [
        n.tab === "group" ? "黑户群" : "黑户用户",
        "（",
        n.ids.length,
        "）"
      ] }),
      n.loading ? /* @__PURE__ */ e("div", { className: "mk-state", children: "加载中…" }) : null,
      !n.loading && !n.ids.length ? /* @__PURE__ */ e("div", { className: "mk-state", children: "暂无黑户" }) : null,
      !n.loading && n.ids.length ? /* @__PURE__ */ e("div", { className: "bl-list", children: n.ids.map((d) => /* @__PURE__ */ o("div", { className: "bl-row", children: [
        /* @__PURE__ */ e("span", { className: "bl-row__id", children: d }),
        /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost mk-btn--sm", onClick: () => void n.removeId(d), children: "移除" })
      ] }, d)) }) : null
    ] })
  ] });
}
const Oa = La(null);
function Ci({ children: a }) {
  const i = Ke(), [t, n] = v(null), [l, u] = v(null), [d, m] = v(null);
  q(() => {
    m(document.body);
  }, []);
  const c = E((h) => n(h), []), r = E(() => n(null), []), x = Z(
    () => ({ content: t, isOpen: t != null, open: c, close: r, host: l }),
    [t, c, r, l]
  ), k = /* @__PURE__ */ e(
    "div",
    {
      className: `mk-overlay-host mkai-admin is-${i}`,
      ref: u,
      "data-mkai-overlay-host": "",
      "aria-hidden": !1
    }
  );
  return /* @__PURE__ */ o(Oa.Provider, { value: x, children: [
    a,
    d ? ke(k, d) : null
  ] });
}
function xe() {
  const a = Ra(Oa);
  if (!a) throw new Error("useOverlay 必须在 OverlayProvider 内使用");
  return a;
}
function Ba({
  open: a,
  onClose: i,
  children: t,
  className: n = ""
}) {
  const { host: l } = xe();
  return !a || !l ? null : ke(
    /* @__PURE__ */ e(
      "div",
      {
        className: `mk-modal-overlay${n ? ` ${n}` : ""}`,
        onClick: (u) => {
          i && u.target === u.currentTarget && i();
        },
        children: t
      }
    ),
    l
  );
}
function oe(a) {
  return /^custom_[a-zA-Z0-9_-]{1,64}$/.test(String(a || "").trim());
}
function Si() {
  return `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
const me = {
  deepseek: {
    id: "deepseek",
    name: "深度求索",
    website: "https://platform.deepseek.com/",
    docs: "https://api-docs.deepseek.com/",
    base_url: "https://api.deepseek.com",
    balance_url: "https://api.deepseek.com/user/balance",
    chat_path: "/v1/chat/completions",
    models: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash（更快更省）" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro（更强）" }
    ],
    default_model: "deepseek-v4-flash"
  },
  nvidia: {
    id: "nvidia",
    name: "英伟达 NIM",
    website: "https://build.nvidia.com/",
    docs: "https://docs.api.nvidia.com/nim/",
    base_url: "https://integrate.api.nvidia.com/v1",
    balance_url: "",
    chat_path: "/chat/completions",
    models: [
      { value: "deepseek-ai/deepseek-v4-flash-0731", label: "deepseek-v4-flash-0731（1M · 官方最新）" },
      { value: "nvidia/nemotron-3-ultra-550b-a55b", label: "nemotron-3-ultra（1M）" },
      { value: "nvidia/nemotron-3-super-120b-a12b", label: "nemotron-3-super（1M）" },
      { value: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "nemotron-3.5-lightning（快）" },
      { value: "openai/gpt-oss-120b", label: "gpt-oss-120b（128K）" },
      { value: "openai/gpt-oss-20b", label: "gpt-oss-20b（128K）" },
      { value: "moonshotai/kimi-k2.6", label: "kimi-k2.6（128K）" },
      { value: "meta/llama-3.3-70b-instruct", label: "llama-3.3-70b（128K）" },
      { value: "google/gemma-4-31b-it", label: "gemma-4-31b（128K）" },
      { value: "google/diffusiongemma-26b-a4b-it", label: "diffusiongemma-26b（128K）" }
    ],
    default_model: "deepseek-ai/deepseek-v4-flash-0731"
  }
};
function be(a, i = []) {
  if (a in me) return me[a];
  const t = i.find((n) => n.id === a);
  return t ? {
    id: t.id,
    name: t.name,
    website: "",
    docs: "",
    base_url: t.base_url,
    balance_url: String(t.balance_url || "").trim(),
    chat_path: t.chat_path || "",
    models: [{ value: t.model, label: t.model }],
    default_model: t.model
  } : me.deepseek;
}
function $i(a) {
  return String(a || "").toLowerCase() === "anthropic" ? "Anthropic" : "OpenAI";
}
function Se(a) {
  const i = String(a.vendor || "").trim();
  return oe(i) && (a.custom_vendors || []).some((n) => n.id === i) || i in me ? i : String(a.base_url || "").includes("nvidia.com") ? "nvidia" : "deepseek";
}
function Mi(a, i) {
  if (oe(String(a))) {
    const n = i === "hcnsec" || !i;
    return {
      totalLabel: "账户余额",
      meterTitle: n ? "额度构成（已用 / 总额）" : "余额构成（充值 / 赠送）",
      toppedLabel: n ? "已用额度" : "充值余额",
      grantedLabel: n ? "令牌总额" : "赠送余额",
      refreshBtn: "刷新余额",
      hideCache: !1,
      hideBalanceUrl: !1
    };
  }
  const t = a === "nvidia";
  return {
    totalLabel: t ? "近1分钟用量" : "账户余额",
    meterTitle: t ? "每分钟请求占比（免费档约 40 RPM）" : "余额构成（充值 / 赠送）",
    toppedLabel: t ? "本分钟已用" : "充值余额",
    grantedLabel: t ? "参考上限 RPM" : "赠送余额",
    refreshBtn: t ? "刷新限速" : "刷新余额",
    hideCache: t,
    hideBalanceUrl: t
  };
}
function Oe(a) {
  const i = Number(a);
  return !Number.isFinite(i) || i <= 0 ? 0 : Math.min(999, Math.max(1, Math.floor(i)));
}
function Ne(a) {
  return Math.max(0, Math.min(100, Number(a) || 0));
}
function Ka(a) {
  return a == null || Number.isNaN(Number(a)) ? "—" : `${Ne(a).toFixed(1)}%`;
}
function de(a) {
  const i = Number(a) || 0;
  return i >= 1e6 ? `${(i / 1e6).toFixed(2).replace(/\.?0+$/, "")}M` : i >= 1e4 ? `${(i / 1e3).toFixed(1)}k` : String(i);
}
function Ze(a) {
  const i = Number(a) || 0;
  return i < 1024 ? `${i} B` : i < 1024 * 1024 ? `${(i / 1024).toFixed(1)} KB` : i < 1024 * 1024 * 1024 ? `${(i / (1024 * 1024)).toFixed(2)} MB` : `${(i / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function zi(a) {
  return `${Ze(a)}/s`;
}
function Ti(a) {
  if (a == null || !Number.isFinite(Number(a))) return "计算中…";
  let i = Math.max(0, Math.ceil(Number(a)));
  if (i <= 0) return "即将完成";
  if (i < 60) return `约剩余 ${i} 秒`;
  const t = Math.floor(i / 3600);
  i %= 3600;
  const n = Math.floor(i / 60);
  return i %= 60, t > 0 ? i > 0 || n > 0 ? `约剩余 ${t} 小时 ${n} 分` : `约剩余 ${t} 小时` : i > 0 ? `约剩余 ${n} 分 ${i} 秒` : `约剩余 ${n} 分`;
}
const Ge = {
  tavily: !1,
  serper: !1,
  bocha: !1
}, Ve = [
  { value: "same_vendor", label: "本厂商内", full: "仅本厂商内轮替切换" },
  { value: "other_vendor_default", label: "其他厂商", full: "其他厂商模型" },
  { value: "other_vendor_any", label: "任意模型", full: "其他厂商任意模型" }
], Ei = [
  "仅本厂商内轮替切换：同 Key 同地址拉取模型列表，随机换一个别的模型；没有别的模型即判失败。",
  "其他厂商模型：换到其他已配好的自定义厂商，只用它自己保存的模型；没有其他厂商即判失败。",
  "其他厂商任意模型：换到一家后随机试完它列表里的模型，全不行再换下一家；次数填 N 则累计 N 次仍失败即判失败。"
];
function ja(a) {
  const i = String(a || "").trim().toLowerCase();
  return i === "other_vendor_default" || i === "other_vendor_any" ? i : "same_vendor";
}
function ua(a) {
  const i = Number(a.model_rotation_limit);
  return {
    enabled: a.model_rotation_enabled === !0,
    mode: ja(a.model_rotation_mode),
    limit: Number.isFinite(i) ? Math.min(20, Math.max(0, Math.round(i))) : 3
  };
}
function Li(a) {
  return {
    model_rotation_enabled: a.enabled === !0,
    model_rotation_mode: ja(a.mode),
    model_rotation_limit: Math.min(20, Math.max(0, Math.round(Number(a.limit) || 0)))
  };
}
function ka(a) {
  const i = a.image_recognize || {};
  return {
    timeout_sec: i.timeout_sec ?? 30,
    queue_normal: i.queue_normal ?? 3,
    queue_at: i.queue_at ?? 3,
    per_msg_normal: i.per_msg_normal ?? 3,
    per_msg_at: i.per_msg_at ?? 2
  };
}
function ga(a) {
  const i = a.custom_vendors || [], t = Se(a), n = be(t, i), l = oe(String(t)) ? i.find((d) => d.id === t) : void 0, u = n.models.some((d) => d.value === a.model);
  return {
    vendor: t,
    apiKey: "",
    baseUrl: a.base_url || l?.base_url || "",
    balanceUrl: a.balance_url || l?.balance_url || "",
    model: l ? a.model || l.model : u && a.model || n.default_model,
    temperature: a.temperature ?? l?.temperature ?? 0.7,
    maxTokens: a.max_tokens ?? l?.max_tokens ?? 2048,
    customName: l?.name || "",
    chatPath: l?.chat_path ?? "",
    apiProtocol: l?.api_protocol || "openai"
  };
}
function fa(a) {
  return {
    debounceMs: a.debounce_ms ?? 8e3,
    maxBatch: a.max_batch ?? 12,
    randomWaitEnabled: a.random_wait_enabled !== !1,
    randomWaitMinMin: Math.round((a.random_wait_min_ms ?? 6e4) / 6e4),
    randomWaitMaxMin: Math.round((a.random_wait_max_ms ?? 18e5) / 6e4),
    silenceVetoPercent: Math.round((a.silence_veto_ratio ?? 0.55) * 100),
    replyGapMs: a.reply_gap_ms ?? 1200,
    kbTopM: a.kb_top_m ?? 3,
    shutUpLimit: a.shut_up_limit ?? 5,
    actionMin: a.action_min ?? 0,
    actionMax: a.action_max ?? 3,
    systemPrompt: a.system_prompt || "",
    privateEnabled: !0
  };
}
function ba(a, i, t) {
  let n = Math.min(10, Math.max(0, Number(i.actionMin) || 0)), l = Math.min(10, Math.max(0, Number(i.actionMax) || 3));
  l < 1 && (l = 1), n > l && (n = l);
  const u = String(i.systemPrompt || "").trim(), d = String(t?.defaultSystemPrompt || "").trim(), m = d && u === d ? "" : u, c = {
    vendor: a.vendor,
    base_url: a.baseUrl.trim(),
    balance_url: a.balanceUrl.trim(),
    model: a.model.trim(),
    temperature: Number(a.temperature),
    max_tokens: Number(a.maxTokens),
    debounce_ms: Number(i.debounceMs),
    max_batch: Math.min(25, Math.max(1, Number(i.maxBatch) || 12)),
    random_wait_enabled: i.randomWaitEnabled !== !1,
    random_wait_min_ms: Math.min(60, Math.max(1, Number(i.randomWaitMinMin) || 1)) * 6e4,
    random_wait_max_ms: Math.min(60, Math.max(1, Number(i.randomWaitMaxMin) || 30)) * 6e4,
    silence_veto_ratio: Math.min(100, Math.max(0, Number(i.silenceVetoPercent) || 0)) / 100,
    reply_gap_ms: Math.min(8e3, Math.max(400, Number(i.replyGapMs) || 1200)),
    kb_top_m: Number(i.kbTopM),
    shut_up_limit: Math.min(50, Math.max(1, Number(i.shutUpLimit) || 5)),
    action_min: n,
    action_max: l,
    system_prompt: m,
    /** 私聊由「聊天开关」按好友控制，总开关恒开 */
    private_chat_enabled: !0
  }, r = a.apiKey.trim();
  return r && (c.api_key = r), t?.customVendors && (c.custom_vendors = t.customVendors.map((x) => ({
    id: x.id,
    name: x.name,
    base_url: x.base_url,
    model: x.model,
    temperature: x.temperature ?? 0.7,
    max_tokens: x.max_tokens ?? 2048,
    chat_path: String(x.chat_path ?? "").trim(),
    api_protocol: x.api_protocol || "openai",
    ...x.api_key && !x.api_key.includes("…") ? { api_key: x.api_key } : {}
  }))), t?.deleteCustomVendor && (c.delete_custom_vendor = t.deleteCustomVendor), c;
}
function ha(a, i) {
  const t = {}, n = a.keys.tavily.trim(), l = a.keys.serper.trim(), u = a.keys.bocha.trim();
  n && !n.includes("…") && (t.tavily_key = n), l && !l.includes("…") && (t.serper_key = l), u && !u.includes("…") && (t.bocha_key = u), i.tavily && (t.clear_tavily_key = !0), i.serper && (t.clear_serper_key = !0), i.bocha && (t.clear_bocha_key = !0);
  const d = a.imageRecognize;
  return {
    tools_max_rounds: Math.min(5, Math.max(1, Number(a.toolsMaxRounds) || 3)),
    image_recognize: {
      timeout_sec: Math.min(120, Math.max(5, Math.floor(Number(d.timeout_sec) || 30))),
      queue_normal: Math.min(20, Math.max(1, Math.floor(Number(d.queue_normal) || 3))),
      queue_at: Math.min(20, Math.max(1, Math.floor(Number(d.queue_at) || 3))),
      per_msg_normal: Math.min(10, Math.max(1, Math.floor(Number(d.per_msg_normal) || 3))),
      per_msg_at: Math.min(10, Math.max(1, Math.floor(Number(d.per_msg_at) || 2)))
    },
    web_search: t
  };
}
function Ri(a, i, t) {
  const n = i.web_search_masked || {};
  return !!{
    tavily: !!n.tavily_set,
    serper: !!n.serper_set,
    bocha: !!n.bocha_set
  }[a] && !t[a];
}
const we = {
  enabled: !1,
  ai_only: !1,
  rounds: 0,
  image_recognize: !1,
  file_recognize: !1,
  sticker_output: !1,
  web_search: !1,
  at_only: !1,
  at_only_record: !0,
  fake_think: !1,
  allow_voice: !1,
  system_prompt: ""
};
function Da(a) {
  return `http://p.qlogo.cn/gh/${a}/${a}/100/`;
}
function Be(a) {
  return `http://q.qlogo.cn/headimg_dl?dst_uin=${a}&spec=640`;
}
function Pi(a) {
  const i = [];
  a.at_only && i.push("仅@"), a.image_recognize && i.push("识图"), a.file_recognize && i.push("文件"), a.web_search && i.push("联网"), a.sticker_output && i.push("表情"), a.fake_think && i.push("思考");
  const t = Oe(a.rounds);
  return t > 0 && i.push(`轮次${t}`), i;
}
function oa(a, i, t) {
  return i ? a === "nvidia" ? `${i.total_balance} RPM` : `${i.total_balance} ${i.currency || "CNY"}` : t.error || "—";
}
function Ua(a, i, t) {
  if (!i) return null;
  const n = Number(i.topped_up_balance || 0), l = Number(i.granted_balance || 0), u = Number(i.total_balance || 0) || n + l;
  if (a === "nvidia") {
    const d = Number(t.meta?.rpm_used ?? n), m = Number(t.meta?.rpm_limit ?? l) || 40;
    return m > 0 ? Math.max(0, Math.min(100, d / m * 100)) : 0;
  }
  return u > 0 ? n / u * 100 : 0;
}
function Ii(a, i, t) {
  const n = "var(--mk-success, #16a34a)", l = "var(--mk-danger, #ef4444)";
  return t != null && Number.isFinite(t) && a === "nvidia" ? { text: `${i ? "用量 " : "限速 "}${t.toFixed(1)}%`, color: i ? n : l } : i ? { text: "可用", color: n } : {
    text: a === "nvidia" ? "接近限速" : "不可用",
    color: l
  };
}
function Ai(a, i, t) {
  if (!i) return t.error || "未配置余额地址或密钥";
  if (a === "nvidia") {
    const n = t.meta?.token_name ? `令牌「${t.meta.token_name}」 · ` : "", l = t.meta?.header_remaining, u = t.meta?.header_limit, d = t.meta?.reset_in_sec, m = l != null || u != null ? `响应头剩余 ${l ?? "—"} / ${u ?? "—"}` : "响应头暂无（对话后会更新）", c = d != null ? ` · 约 ${d}s 后重置` : "";
    return `${n}${m}${c} · 更新于 ${t.fetched_at || "—"} · 本地统计近 60 秒请求；免费档常见约 40 RPM，官方无余额接口`;
  }
  return `更新于 ${t.fetched_at || "—"} · 进度条表示充值余额占比`;
}
const qi = "mk_sc_sticker_job_";
function Oi(a, i) {
  try {
    a && i && sessionStorage.setItem(qi + a, String(i));
  } catch {
  }
}
const Fa = 6e4, Bi = 1e4;
let se = null, fe = null;
async function Ki(a, i, t, n) {
  const l = Se(i || {}), u = new AbortController(), d = () => u.abort();
  n.addEventListener("abort", d);
  const m = setTimeout(() => u.abort(), Bi);
  let c = {};
  try {
    c = (await a.get(
      "/smart-chat/balance",
      t ? { _t: Date.now(), force: 1 } : { _t: Date.now() },
      { signal: u.signal }
    ))?.data || {};
  } catch {
    c = {};
  } finally {
    clearTimeout(m), n.removeEventListener("abort", d);
  }
  const r = c.infos?.[0] || null, x = oa(l, r, c) || "—", k = !c.error && (!!r || !!c.available);
  return {
    data: c,
    vendor: l,
    label: x,
    pct: Ua(l, r, c),
    available: !!c.available,
    tone: k ? "ok" : "warn",
    isRate: l === "nvidia"
  };
}
function Qa(a, i, t = {}) {
  const n = !!t.force, l = t.signal ?? new AbortController().signal;
  if (!n && se && Date.now() - se.at < Fa)
    return Promise.resolve(se.snap);
  if (n)
    se = null;
  else if (fe)
    return fe;
  const u = Ki(a, i, n, l);
  return fe = u, u.then((d) => (se = { at: Date.now(), snap: d }, d)).finally(() => {
    fe === u && (fe = null);
  });
}
function ji() {
  se = null, fe = null;
}
function Di() {
  return !se || Date.now() - se.at >= Fa ? null : se.snap;
}
function Wa(a) {
  return !!a && ["running", "pending", "downloading", "extracting"].includes(String(a.status || ""));
}
const ea = [
  { id: "kakake", label: "kakake 服务器", desc: "从插件内置域名下载，国内直连一般更快" },
  { id: "github", label: "GitHub 仓库", desc: "从 GitHub Releases 下载，源站更新更及时（可能需代理）" }
], aa = "kakake";
function ia(a) {
  const i = ea.find((t) => t.id === a);
  return i ? i.label : ea[0].label;
}
function Ui({
  api: a,
  toast: i,
  confirm: t,
  section: n,
  pickStickerSource: l
}) {
  const [u, d] = v({}), [m, c] = v(() => ga({})), [r, x] = v(() => fa({})), [k, h] = v(() => ({
    toolsMaxRounds: 3,
    imageRecognize: ka({}),
    keys: { tavily: "", serper: "", bocha: "" }
  })), [y, s] = v({ ...Ge }), [p, g] = v(() => ua({})), [_, C] = v(!1), [P, $] = v(""), [W, K] = v({}), [A, U] = v({}), [F, G] = v(!1), [H, L] = v([]), [w, M] = v([]), [I, O] = v(!1), [Q, ae] = v({
    tavily: "",
    serper: "",
    bocha: ""
  }), [te, Y] = v("default"), [X, pe] = v([]), [ie, J] = v(!1), [S, V] = v(""), [ve, le] = v(!1), [De, $e] = v(!1), [Me, ue] = v(!1), [Ue, N] = v([]), z = j(null), D = j({}), ee = m.vendor, Za = oe(String(ee)) || ie, ei = be(ee, X), ai = Mi(ee, A.display), ii = E((f, b) => {
    const R = be(f);
    for (const T of [b, D.current[f]])
      if (T && R.models.some((B) => B.value === T)) return T;
    return R.default_model;
  }, []), ge = E((f) => {
    d(f || {}), pe(f?.custom_vendors || []), J(!1), V("");
    const b = ga(f || {});
    c(b), b.vendor && b.model && (D.current[b.vendor] = b.model), x(fa(f || {})), h({
      toolsMaxRounds: f?.tools_max_rounds ?? 3,
      imageRecognize: ka(f || {}),
      keys: { tavily: "", serper: "", bocha: "" }
    }), s({ ...Ge }), g(ua(f || {})), f?.default_system_prompt && $(f.default_system_prompt), Y(f?.api_key_set ? "ok" : "default");
  }, []), ze = E(async () => {
    const f = await a.get("/smart-chat/config");
    if (f.code !== 0) throw new Error(f.message || "加载配置失败");
    ge(f.data || {});
  }, [a, ge]), Te = E(async () => {
    try {
      const f = await a.get("/smart-chat/usage");
      K(f.data || {});
    } catch {
    }
  }, [a]), Fe = E(async (f = !1) => {
    G(!0);
    try {
      f && ji();
      const b = await a.get("/smart-chat/balance", f ? { force: 1, refresh: 1, _t: Date.now() } : { _t: Date.now() });
      if (U(b.data || {}), f) {
        const R = b.data?.infos?.[0] || null, T = Se(u), B = oa(T, R || null, b.data || {});
        i(
          R ? T === "nvidia" ? `限速已刷新：${B}` : `余额已刷新：${B}` : b.data?.error || "刷新完成",
          R ? "ok" : "warn"
        );
      }
    } catch (b) {
      U({ error: b instanceof Error ? b.message : String(b) }), f && i(`刷新余额失败: ${b instanceof Error ? b.message : b}`, "err");
    } finally {
      G(!1);
    }
  }, [a, u, i]), sa = j(i);
  sa.current = i;
  const la = E(async () => {
    try {
      await ze(), await Te();
    } catch (f) {
      sa.current(f instanceof Error ? f.message : String(f));
    }
  }, [ze, Te]);
  q(() => {
    la();
  }, [la]), q(() => {
    n === "model" && Fe(!1);
  }, [n, Fe]);
  const Qe = E(async () => {
    try {
      const f = await a.get("/smart-chat/tool-skills");
      L(f.data?.tools || []);
    } catch (f) {
      i(f instanceof Error ? f.message : String(f), "err");
    }
  }, [a, i]), _e = E(async () => {
    try {
      const f = await a.get("/smart-chat/sticker/galleries");
      M(f.data?.galleries || []), O(!!f.data?.ready);
    } catch (f) {
      i(f instanceof Error ? f.message : String(f), "err");
    }
  }, [a, i]);
  q(() => {
    n === "skills" && (Qe(), _e());
  }, [n, Qe, _e]), q(() => {
    if (n !== "skills") return;
    if (!w.some((b) => Wa(b.activeJob))) {
      z.current && (window.clearInterval(z.current), z.current = null);
      return;
    }
    if (!z.current)
      return z.current = window.setInterval(() => {
        _e();
      }, 1200), () => {
        z.current && (window.clearInterval(z.current), z.current = null);
      };
  }, [n, w, _e]);
  const ti = (f) => {
    if (f === ee && !ie) return;
    if (J(!1), V(""), ue(!1), N([]), D.current[ee] = m.model, oe(String(f))) {
      const B = X.find((re) => re.id === f);
      if (!B) return;
      c((re) => ({
        ...re,
        vendor: f,
        apiKey: "",
        baseUrl: B.base_url,
        balanceUrl: String(B.balance_url || "").trim(),
        model: B.model,
        temperature: B.temperature ?? 0.7,
        maxTokens: B.max_tokens ?? 2048,
        customName: B.name,
        chatPath: B.chat_path ?? "",
        apiProtocol: B.api_protocol || "openai"
      })), Y(B.api_key_set ? "ok" : "default"), i(`已切换为自定义「${B.name}」`, "info");
      return;
    }
    const b = be(f), R = u.vendor === f ? String(u.model || "") : "", T = ii(f, R || D.current[f]);
    D.current[f] = T, c((B) => ({
      ...B,
      vendor: f,
      apiKey: "",
      baseUrl: b.base_url,
      balanceUrl: b.balance_url,
      model: T,
      customName: "",
      chatPath: b.chat_path
    })), Y(u.api_key_set && u.vendor === f ? "ok" : "default"), i(`已切换为「${b.name}」预设，请填写密钥后保存`, "info");
  }, ri = (f) => {
    D.current[ee] = f, c((b) => ({ ...b, model: f }));
  }, da = (f = "openai") => {
    J(!0), V(""), ue(!1), N([]), c((b) => ({
      ...b,
      vendor: "",
      apiKey: "",
      baseUrl: f === "anthropic" ? "https://api.anthropic.com" : "",
      balanceUrl: "",
      model: "",
      temperature: 0.7,
      maxTokens: 2048,
      customName: "",
      chatPath: f === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
      apiProtocol: f
    })), Y("default");
  }, ni = () => da("anthropic"), oi = (f, b) => {
    const R = m.balanceUrl.trim(), T = {
      id: f,
      name: b,
      base_url: m.baseUrl.trim(),
      ...R ? { balance_url: R } : {},
      model: m.model.trim(),
      temperature: Number(m.temperature),
      max_tokens: Number(m.maxTokens),
      chat_path: String(m.chatPath ?? "").trim(),
      api_protocol: m.apiProtocol || "openai",
      api_key: m.apiKey.trim() || void 0
    };
    return [...X.filter((re) => re.id !== f), T];
  }, si = async () => {
    try {
      let f = m, b = X;
      if (ie || oe(String(m.vendor))) {
        const T = String(m.customName || "").trim();
        if (!T) {
          i("请填写自定义厂商名称", "warn");
          return;
        }
        if (!m.baseUrl.trim() || !m.model.trim()) {
          i("请填写 Base URL 与模型 ID", "warn");
          return;
        }
        if (ie && !m.apiKey.trim()) {
          i("新建自定义厂商请填写 API Key", "warn");
          return;
        }
        const B = ie ? Si() : String(m.vendor);
        b = oi(B, T), f = { ...m, vendor: B, customName: T };
      }
      const R = await a.post(
        "/smart-chat/config",
        ba(f, r, {
          customVendors: b,
          defaultSystemPrompt: P
        })
      );
      if (R.code !== 0) throw new Error(R.message || "保存失败");
      ge(R.data || {}), i(R.data?.fingerprint_changed ? "已保存：会话命名空间已切换" : "配置已保存", "ok"), Te();
    } catch (f) {
      i(f instanceof Error ? f.message : String(f), "err");
    }
  }, li = async () => {
    C(!0);
    try {
      const f = await a.post(
        "/smart-chat/config",
        Li(p)
      );
      if (f.code !== 0) throw new Error(f.message || "保存失败");
      ge(f.data || {}), i("模型轮替设置已保存", "ok");
    } catch (f) {
      i(f instanceof Error ? f.message : String(f), "err");
    } finally {
      C(!1);
    }
  }, di = async (f) => {
    const b = X.find((T) => T.id === f);
    if (await t({
      title: "删除自定义厂商",
      message: `确定删除「${b?.name || f}」？`,
      danger: !0,
      okText: "删除"
    }))
      try {
        const T = X.filter((vi) => vi.id !== f), re = (m.vendor === f ? "deepseek" : m.vendor) === "deepseek" && m.vendor === f ? {
          ...m,
          vendor: "deepseek",
          apiKey: "",
          baseUrl: me.deepseek.base_url,
          balanceUrl: me.deepseek.balance_url,
          model: me.deepseek.default_model,
          customName: ""
        } : m, We = await a.post(
          "/smart-chat/config",
          ba(re, r, {
            customVendors: T,
            deleteCustomVendor: f,
            defaultSystemPrompt: P
          })
        );
        if (We.code !== 0) throw new Error(We.message || "删除失败");
        ge(We.data || {}), i("已删除自定义厂商", "ok");
      } catch (T) {
        i(T instanceof Error ? T.message : String(T), "err");
      }
  }, Ee = (f) => /api_key|api.?key|401|403|unauthorized|invalid.?key|密钥|key_not|not_configured|authentication|鉴权/i.test(f), ci = async () => {
    le(!0), V("请求中…");
    try {
      const f = await a.post("/smart-chat/probe", {
        vendor: oe(String(m.vendor)) ? m.vendor : void 0,
        api_key: m.apiKey.trim() || void 0,
        base_url: m.baseUrl.trim(),
        model: m.model.trim(),
        chat_path: m.chatPath ?? "",
        max_tokens: m.maxTokens,
        temperature: m.temperature,
        api_protocol: m.apiProtocol || "openai"
      }), b = f.data || {}, R = [
        b.ok ? "✓ 访问成功" : "✗ 访问失败",
        b.latency_ms != null ? `耗时 ${b.latency_ms}ms` : "",
        b.status != null ? `HTTP ${b.status}` : "",
        b.error ? `错误: ${b.error}` : "",
        b.content != null ? `回复: ${b.content}` : "",
        b.raw ? `--- raw ---
${b.raw}` : ""
      ].filter(Boolean);
      V(R.join(`
`)), b.ok ? (Y("ok"), i("测试访问成功", "ok")) : (Ee(String(b.error || f.message || "")) && Y("err"), i(`测试访问失败: ${b.error || f.message || "未知错误"}`, "err"));
    } catch (f) {
      const b = f instanceof Error ? f.message : String(f);
      V(`异常: ${b}`), Ee(b) && Y("err"), i(b, "err");
    } finally {
      le(!1);
    }
  }, mi = async () => {
    if (!m.baseUrl.trim()) {
      i("请先填写 Base URL", "warn");
      return;
    }
    $e(!0);
    try {
      const f = await a.post("/smart-chat/models", {
        vendor: oe(String(m.vendor)) ? m.vendor : void 0,
        api_key: m.apiKey.trim() || void 0,
        base_url: m.baseUrl.trim(),
        chat_path: m.chatPath ?? "",
        api_protocol: m.apiProtocol || "openai"
      }), b = f.data || {};
      if (f.code !== 0 || !b.ok)
        throw new Error(b.error || f.message || "拉取失败");
      const R = Array.isArray(b.models) ? b.models : [];
      N(R), ue(!0), i(R.length ? `已拉取 ${R.length} 个模型` : "未返回模型", R.length ? "ok" : "warn");
    } catch (f) {
      i(f instanceof Error ? f.message : String(f), "err");
    } finally {
      $e(!1);
    }
  }, pi = async () => {
    try {
      const f = await a.post("/smart-chat/config", ha(k, y));
      if (f.code !== 0) throw new Error(f.message || "保存失败");
      ge(f.data || {}), i(f.data?.fingerprint_changed ? "联网配置已保存：会话命名空间已切换" : "联网配置已保存", "ok");
    } catch (f) {
      i(f instanceof Error ? f.message : String(f), "err");
    }
  }, ui = async () => {
    le(!0), V("请求中…");
    try {
      const f = await a.post("/smart-chat/test", {}), b = f.data || {}, R = String(b.error || b.message || f.message || ""), T = [
        b.ok ? "✓ 访问成功" : "✗ 访问失败",
        b.model ? `模型 ${b.model}` : "",
        b.latency_ms != null ? `耗时 ${b.latency_ms}ms` : "",
        b.status != null ? `HTTP ${b.status}` : "",
        b.error ? `错误: ${b.error}` : "",
        b.content != null ? `回复: ${b.content}` : "",
        b.raw ? `--- raw ---
${b.raw}` : ""
      ].filter(Boolean);
      if (V(T.join(`
`)), f.code === 0 && b.ok) {
        Y(u.api_key_set || m.apiKey.trim() ? "ok" : "default");
        const B = b.content ? `：${b.content}` : "";
        i(`连通性正常${b.latency_ms != null ? `（${b.latency_ms}ms）` : ""}${B}`, "ok");
      } else
        Ee(R) && Y("err"), i(`连通性失败: ${R || "未知错误"}`, "err");
    } catch (f) {
      const b = f instanceof Error ? f.message : String(f);
      V(`异常: ${b}`), Ee(b) && Y("err"), i(b, "err");
    } finally {
      le(!1);
    }
  }, ki = async (f) => {
    ae((b) => ({ ...b, [f]: "测试中…" }));
    try {
      const b = ha(k, y);
      (Object.keys(b.web_search).length > 0 || y.tavily || y.serper || y.bocha) && (await a.post("/smart-chat/config", b), s({ ...Ge }), await ze());
      const T = await a.post("/smart-chat/web-search/test", { provider: f }), B = T.code === 0 && T.data?.ok;
      ae((re) => ({
        ...re,
        [f]: B ? `正常${T.data?.may_consume_quota ? "（已耗极少额度）" : ""}` : T.data?.error || T.message || "失败"
      })), i(
        B ? `${f} 测试通过` : `${f} 测试失败: ${T.data?.error || T.message}`,
        B ? "ok" : "err"
      );
    } catch (b) {
      ae((R) => ({ ...R, [f]: b instanceof Error ? b.message : "失败" })), i(`测试失败: ${b instanceof Error ? b.message : b}`, "err");
    }
  }, gi = async () => {
    if (await t({
      title: "清空用量",
      message: "确定清空本地用量账本？此操作不可恢复。",
      danger: !0,
      okText: "清空"
    }))
      try {
        await a.post("/smart-chat/usage/clear", {}), await Te(), i("已清空本地用量", "ok");
      } catch (b) {
        i(b instanceof Error ? b.message : String(b), "err");
      }
  }, fi = async (f, b) => {
    try {
      await a.post("/smart-chat/tool-skills/toggle", { code: f, enabled: b }), await Qe();
    } catch (R) {
      i(R instanceof Error ? R.message : String(R), "err");
    }
  }, bi = async (f) => {
    const b = w.find((T) => T.id === f);
    if (!b) {
      i("未找到图库定义", "err");
      return;
    }
    const R = l ? await l(b) : aa;
    if (R && !(b.installed && !await t({
      title: "重新安装",
      message: `重新安装将覆盖本地「${b.name || b.id}」的图片（源：${ia(R)}），是否继续？`,
      danger: !0,
      okText: "重新安装"
    })))
      try {
        const T = await a.post("/smart-chat/sticker/install", {
          galleryId: f,
          id: f,
          source: R
        });
        T.data?.jobId && Oi(f, T.data.jobId), i(`${b.installed ? "开始重新安装图库" : "开始安装图库"} · ${ia(R)}`, "info"), _e();
      } catch (T) {
        i(T instanceof Error ? T.message : String(T), "err");
      }
  }, ca = A.infos?.[0] || null, ma = Ua(ee, ca, A), hi = Ii(ee, A.available, ma), xi = Z(
    () => [
      { id: "tavily", name: "Tavily", home: "https://app.tavily.com/home", docs: "https://docs.tavily.com" },
      { id: "serper", name: "Serper", home: "https://serper.dev", docs: "" },
      { id: "bocha", name: "博查", home: "https://open.bochaai.com/api-keys", docs: "https://open.bochaai.com/" }
    ],
    []
  );
  return {
    cfg: u,
    model: m,
    setModel: c,
    context: r,
    setContext: x,
    online: k,
    setOnline: h,
    clearFlags: y,
    setClearFlags: s,
    rotation: p,
    setRotation: g,
    rotationSaving: _,
    saveRotation: li,
    defaultPrompt: P,
    usage: W,
    balance: A,
    balanceLoading: F,
    toolSkills: H,
    galleries: w,
    galleryReady: I,
    providerStatus: Q,
    keyTone: te,
    setKeyTone: Y,
    customVendors: X,
    addingCustom: ie,
    setAddingCustom: J,
    probeLog: S,
    setProbeLog: V,
    probeBusy: ve,
    fetchingModels: De,
    modelListOpen: Me,
    setModelListOpen: ue,
    modelOptions: Ue,
    fetchModelList: mi,
    vendor: ee,
    isCustom: Za,
    preset: ei,
    labels: ai,
    info: ca,
    barPct: ma,
    badge: hi,
    providers: xi,
    loadConfig: ze,
    loadBalance: Fe,
    selectModel: ri,
    onVendorChange: ti,
    startAddCustom: da,
    startAddCustomAnthropic: ni,
    saveConfig: si,
    deleteCustomVendor: di,
    testProbe: ci,
    saveOnline: pi,
    testConnection: ui,
    testWebSearch: ki,
    clearUsage: gi,
    toggleTool: fi,
    installGallery: bi
  };
}
function xa({
  title: a,
  pct: i,
  sub: t,
  warnBelow: n,
  balance: l,
  badgeText: u,
  badgeColor: d
}) {
  const m = Ne(i ?? 0), c = n != null && i != null && i < n;
  return /* @__PURE__ */ o("div", { className: "sc-meter", children: [
    /* @__PURE__ */ o("div", { className: "sc-meter__head", children: [
      /* @__PURE__ */ e("span", { className: "sc-meter__title", children: a }),
      /* @__PURE__ */ e("span", { className: "sc-meter__pct", style: d ? { color: d } : void 0, children: u ?? Ka(i) })
    ] }),
    /* @__PURE__ */ e("div", { className: "sc-meter__track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(m), children: /* @__PURE__ */ e(
      "div",
      {
        className: `sc-meter__fill${l ? " sc-meter__fill--balance" : ""}${c ? " sc-meter__fill--warn" : ""}`,
        style: { width: `${m.toFixed(1)}%` }
      }
    ) }),
    /* @__PURE__ */ e("p", { className: "sc-meter__sub", children: t })
  ] });
}
function Fi({
  api: a,
  toast: i,
  confirm: t,
  section: n
}) {
  const [l, u] = v(null), d = j(null), m = E(async (s) => (d.current?.(null), new Promise((p) => {
    d.current = p, u({ gallery: s, selected: aa });
  })), []), c = E((s) => {
    const p = d.current;
    d.current = null, u(null), p?.(s);
  }, []), r = Ui({ api: a, toast: i, confirm: t, section: n, pickStickerSource: m }), x = j(null), k = Math.max(
    0,
    Ve.findIndex((s) => s.value === r.rotation.mode)
  ), h = je(k, Ve.length, r.rotation.mode);
  q(() => {
    if (!r.modelListOpen) return;
    const s = (p) => {
      const g = x.current;
      g && !g.contains(p.target) && r.setModelListOpen(!1);
    };
    return document.addEventListener("mousedown", s), () => document.removeEventListener("mousedown", s);
  }, [r.modelListOpen, r.setModelListOpen]);
  const y = r.usage;
  return /* @__PURE__ */ o("section", { className: "mkai-page-config", children: [
    n === "model" ? /* @__PURE__ */ o(ne, { children: [
      /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-2", children: [
        /* @__PURE__ */ o("div", { className: "field field-span-2", style: { marginBottom: 14 }, children: [
          /* @__PURE__ */ o("div", { className: "vendor-grid", role: "radiogroup", "aria-label": "上游厂商", children: [
            Object.values(me).map((s) => {
              const p = !r.addingCustom && r.vendor === s.id, g = s.id === "nvidia" && String(s.default_model).split("/").pop() || s.default_model;
              return /* @__PURE__ */ o(
                "button",
                {
                  type: "button",
                  role: "radio",
                  "aria-checked": p,
                  className: `vendor-card${p ? " is-active" : ""}`,
                  onClick: () => r.onVendorChange(s.id),
                  children: [
                    /* @__PURE__ */ e("span", { className: "vendor-card__name", children: s.name }),
                    /* @__PURE__ */ e("span", { className: "vendor-card__model", children: g })
                  ]
                },
                s.id
              );
            }),
            r.customVendors.map((s) => {
              const p = !r.addingCustom && r.vendor === s.id;
              return /* @__PURE__ */ o(
                "button",
                {
                  type: "button",
                  role: "radio",
                  "aria-checked": p,
                  className: `vendor-card vendor-card--custom${p ? " is-active" : ""}`,
                  onClick: () => r.onVendorChange(s.id),
                  children: [
                    /* @__PURE__ */ o("span", { className: "vendor-card__name-row", children: [
                      /* @__PURE__ */ e("span", { className: "vendor-card__name", children: s.name }),
                      /* @__PURE__ */ e("span", { className: `vendor-card__tag${s.api_protocol === "anthropic" ? " vendor-card__tag--anthropic" : ""}`, children: $i(s.api_protocol) })
                    ] }),
                    /* @__PURE__ */ e("span", { className: "vendor-card__model", children: String(s.model).split("/").pop() || s.model })
                  ]
                },
                s.id
              );
            }),
            /* @__PURE__ */ o(
              "button",
              {
                type: "button",
                className: `vendor-card vendor-card--add${r.addingCustom && r.model.apiProtocol === "openai" ? " is-active" : ""}`,
                "aria-label": "新增 OpenAI 兼容厂商",
                title: "新增 OpenAI 兼容厂商",
                onClick: () => r.startAddCustom("openai"),
                children: [
                  /* @__PURE__ */ e("span", { className: "vendor-card__corner", children: "OpenAI" }),
                  /* @__PURE__ */ e("span", { className: "vendor-card__plus", "aria-hidden": !0, children: "+" })
                ]
              }
            ),
            /* @__PURE__ */ o(
              "button",
              {
                type: "button",
                className: `vendor-card vendor-card--add${r.addingCustom && r.model.apiProtocol === "anthropic" ? " is-active" : ""}`,
                "aria-label": "新增 Anthropic 厂商",
                title: "新增 Anthropic Messages API 厂商",
                onClick: () => r.startAddCustomAnthropic(),
                children: [
                  /* @__PURE__ */ e("span", { className: "vendor-card__corner vendor-card__corner--anthropic", children: "Anthropic" }),
                  /* @__PURE__ */ e("span", { className: "vendor-card__plus", "aria-hidden": !0, children: "+" })
                ]
              }
            )
          ] }),
          !r.isCustom && r.preset.website ? /* @__PURE__ */ o("p", { className: "mk-hint", style: { marginTop: 8 }, children: [
            "获取 API Key：",
            /* @__PURE__ */ e("a", { href: r.preset.website, target: "_blank", rel: "noopener noreferrer", children: r.preset.website }),
            r.preset.docs ? /* @__PURE__ */ o(ne, { children: [
              " · 文档 ",
              /* @__PURE__ */ e("a", { href: r.preset.docs, target: "_blank", rel: "noopener noreferrer", children: "查看" })
            ] }) : null
          ] }) : null
        ] }),
        /* @__PURE__ */ o("div", { className: "form-grid", children: [
          r.isCustom ? /* @__PURE__ */ o("div", { className: "field field-span-2", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "厂商名称" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "text",
                className: "mk-input",
                placeholder: "例如：硅基流动 / 本地 Ollama",
                value: r.model.customName || "",
                onChange: (s) => r.setModel((p) => ({ ...p, customName: s.target.value }))
              }
            )
          ] }) : null,
          /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "API Key" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "text",
                className: `mk-input mk-input--secret${r.keyTone === "ok" ? " mk-input--ok" : ""}${r.keyTone === "err" ? " mk-input--err" : ""}`,
                name: "mkai-sc-api-key",
                placeholder: r.isCustom ? r.customVendors.find((s) => s.id === r.vendor)?.api_key_set ? "已配置（留空不修改）" : "粘贴 API Key" : r.cfg.api_key_set ? "已配置（留空不修改）" : "粘贴 API Key",
                autoComplete: "off",
                autoCorrect: "off",
                autoCapitalize: "off",
                spellCheck: !1,
                "data-lpignore": "true",
                "data-1p-ignore": "true",
                "data-form-type": "other",
                value: r.model.apiKey,
                onChange: (s) => {
                  const p = s.target.value;
                  r.setModel((g) => ({ ...g, apiKey: p })), (r.keyTone === "err" || !p.trim() && !r.cfg.api_key_set || p.trim()) && r.setKeyTone("default");
                }
              }
            )
          ] }),
          /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "Base URL" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "text",
                className: "mk-input",
                placeholder: r.isCustom ? "https://api.example.com/v1" : r.preset.base_url,
                value: r.model.baseUrl,
                onChange: (s) => r.setModel((p) => ({ ...p, baseUrl: s.target.value }))
              }
            )
          ] }),
          r.labels.hideBalanceUrl ? null : /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "Balance URL" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "text",
                className: "mk-input",
                placeholder: r.isCustom ? "留空自动" : r.preset.balance_url,
                value: r.model.balanceUrl,
                onChange: (s) => r.setModel((p) => ({ ...p, balanceUrl: s.target.value }))
              }
            )
          ] }),
          /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "模型" }),
            r.isCustom ? /* @__PURE__ */ o("div", { className: "mk-model-picker", ref: x, children: [
              /* @__PURE__ */ o("div", { className: "mk-input-with-action", children: [
                /* @__PURE__ */ e(
                  "input",
                  {
                    type: "text",
                    className: "mk-input",
                    placeholder: "模型 ID，仅填一个",
                    value: r.model.model,
                    onChange: (s) => r.setModel((p) => ({ ...p, model: s.target.value }))
                  }
                ),
                /* @__PURE__ */ e(
                  "button",
                  {
                    type: "button",
                    className: "mk-input-with-action__btn",
                    title: "拉取模型列表",
                    disabled: r.fetchingModels,
                    onClick: () => void r.fetchModelList(),
                    children: r.fetchingModels ? "…" : "↻"
                  }
                )
              ] }),
              r.modelListOpen && r.modelOptions.length > 0 ? /* @__PURE__ */ o("div", { className: "mk-model-list", role: "listbox", "aria-label": "模型列表", children: [
                /* @__PURE__ */ o("div", { className: "mk-model-list__head", children: [
                  /* @__PURE__ */ o("span", { children: [
                    r.modelOptions.length,
                    " 个模型"
                  ] }),
                  /* @__PURE__ */ e(
                    "button",
                    {
                      type: "button",
                      className: "mk-model-list__close",
                      "aria-label": "关闭",
                      onClick: () => r.setModelListOpen(!1),
                      children: "×"
                    }
                  )
                ] }),
                /* @__PURE__ */ e("ul", { className: "mk-model-list__items", children: r.modelOptions.map((s) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ e(
                  "button",
                  {
                    type: "button",
                    className: "mk-model-list__item",
                    role: "option",
                    "aria-selected": r.model.model === s,
                    onClick: () => {
                      r.setModel((p) => ({ ...p, model: s })), r.setModelListOpen(!1), i(`已选择 ${s}`, "ok");
                    },
                    children: s
                  }
                ) }, s)) })
              ] }) : null
            ] }) : /* @__PURE__ */ e(
              "select",
              {
                className: "mk-input",
                value: r.model.model,
                onChange: (s) => r.selectModel(s.target.value),
                children: r.preset.models.map((s) => /* @__PURE__ */ e("option", { value: s.value, children: s.label }, s.value))
              }
            )
          ] }),
          r.isCustom ? /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "Chat Path" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "text",
                className: "mk-input",
                placeholder: r.model.apiProtocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
                value: r.model.chatPath ?? "",
                onChange: (s) => r.setModel((p) => ({ ...p, chatPath: s.target.value }))
              }
            )
          ] }) : null,
          /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "Temperature" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "number",
                className: "mk-input",
                step: 0.1,
                min: 0,
                max: 2,
                value: r.model.temperature,
                onChange: (s) => r.setModel((p) => ({ ...p, temperature: Number(s.target.value) }))
              }
            )
          ] }),
          /* @__PURE__ */ o("div", { className: "field", children: [
            /* @__PURE__ */ e("label", { className: "mk-label", children: "Max tokens" }),
            /* @__PURE__ */ e(
              "input",
              {
                type: "number",
                className: "mk-input",
                min: 64,
                max: 16384,
                value: r.model.maxTokens,
                onChange: (s) => r.setModel((p) => ({ ...p, maxTokens: Number(s.target.value) }))
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ o("div", { className: "mk-btn-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", onClick: () => void r.saveConfig(), children: "保存" }),
          r.isCustom ? /* @__PURE__ */ o(ne, { children: [
            /* @__PURE__ */ e(
              "button",
              {
                type: "button",
                className: "mk-btn mk-btn--ghost",
                disabled: r.probeBusy,
                onClick: () => void r.testProbe(),
                children: r.probeBusy ? "测试中…" : "测试访问"
              }
            ),
            !r.addingCustom && oe(String(r.vendor)) ? /* @__PURE__ */ e(
              "button",
              {
                type: "button",
                className: "mk-btn mk-btn--danger",
                onClick: () => void r.deleteCustomVendor(String(r.vendor)),
                children: "删除"
              }
            ) : null,
            r.addingCustom ? /* @__PURE__ */ e(
              "button",
              {
                type: "button",
                className: "mk-btn mk-btn--ghost",
                onClick: () => {
                  r.setAddingCustom(!1), r.setProbeLog(""), r.loadConfig();
                },
                children: "取消"
              }
            ) : null
          ] }) : /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost", onClick: () => void r.testConnection(), children: "连通性测试" })
        ] }),
        r.isCustom ? /* @__PURE__ */ o("div", { className: "field", style: { marginTop: 12 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "测试访问输出" }),
          /* @__PURE__ */ e("pre", { className: "mk-probe-log", children: r.probeLog || "点击「测试访问」将只发送「你好」，不加载插件系统提示词。" })
        ] }) : /* @__PURE__ */ o("div", { className: "field", style: { marginTop: 12 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "连通性测试输出" }),
          /* @__PURE__ */ e("pre", { className: "mk-probe-log", children: r.probeLog || "点击「连通性测试」将用当前配置发送「你好」，返回模型真实输出。" })
        ] })
      ] }),
      /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-3", children: [
        /* @__PURE__ */ e("h2", { className: "panel-title", children: "额度概览" }),
        /* @__PURE__ */ o("div", { className: "mk-cs-stats", children: [
          /* @__PURE__ */ o("div", { className: "mk-cs-stat mk-cs-stat--accent", children: [
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__label", children: r.labels.totalLabel }),
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__value", children: oa(r.vendor, r.info, r.balance) })
          ] }),
          /* @__PURE__ */ o("div", { className: "mk-cs-stat", children: [
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__label", children: "累计 tokens" }),
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__value", children: de(y.total_tokens ?? 0) })
          ] }),
          /* @__PURE__ */ o("div", { className: "mk-cs-stat", children: [
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__label", children: "今日 tokens" }),
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__value", children: de(y.today?.total_tokens ?? 0) })
          ] }),
          r.labels.hideCache ? null : /* @__PURE__ */ o("div", { className: "mk-cs-stat mk-cs-stat--ok", children: [
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__label", children: "累计缓存命中" }),
            /* @__PURE__ */ e("span", { className: "mk-cs-stat__value", children: y.cache_hit_rate_percent != null ? `${de(y.total_cache_hit_tokens ?? 0)} (${y.cache_hit_rate_percent}%)` : de(y.total_cache_hit_tokens ?? 0) })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-4", children: [
        /* @__PURE__ */ e("h2", { className: "panel-title", children: "用量详情" }),
        r.labels.hideCache ? null : /* @__PURE__ */ o(ne, { children: [
          /* @__PURE__ */ e(
            xa,
            {
              title: "缓存命中率（累计 prompt）",
              pct: y.cache_hit_rate_percent ?? null,
              warnBelow: 70,
              sub: `命中 ${de(y.total_cache_hit_tokens || 0)} / prompt ${de(y.total_prompt_tokens || 0)} · 请求 ${y.total_requests || 0} 次`
            }
          ),
          /* @__PURE__ */ e(
            xa,
            {
              title: "今日缓存命中率",
              pct: y.today?.cache_hit_rate_percent ?? null,
              warnBelow: 70,
              sub: `今日命中 ${de(y.today?.cache_hit_tokens || 0)} / prompt ${de(y.today?.prompt_tokens || 0)} · ${y.today?.requests || 0} 次`
            }
          )
        ] }),
        /* @__PURE__ */ o("div", { className: "sc-meter", children: [
          /* @__PURE__ */ o("div", { className: "sc-meter__head", children: [
            /* @__PURE__ */ e("span", { className: "sc-meter__title", children: r.labels.meterTitle }),
            /* @__PURE__ */ e("span", { className: "sc-meter__pct", style: { color: r.badge.color }, children: r.badge.text })
          ] }),
          /* @__PURE__ */ e("div", { className: "sc-meter__track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(Ne(r.barPct ?? 0)), children: /* @__PURE__ */ e("div", { className: "sc-meter__fill sc-meter__fill--balance", style: { width: `${Ne(r.barPct ?? 0).toFixed(1)}%` } }) }),
          /* @__PURE__ */ o("div", { className: "sc-balance-split", children: [
            /* @__PURE__ */ o("div", { className: "sc-balance-split__item", children: [
              /* @__PURE__ */ e("span", { children: r.labels.toppedLabel }),
              /* @__PURE__ */ e("strong", { children: r.info ? r.vendor === "nvidia" ? `${r.info.topped_up_balance} 次` : `${r.info.topped_up_balance} ${r.info.currency || ""}`.trim() : "—" })
            ] }),
            /* @__PURE__ */ o("div", { className: "sc-balance-split__item", children: [
              /* @__PURE__ */ e("span", { children: r.labels.grantedLabel }),
              /* @__PURE__ */ e("strong", { children: r.info ? r.vendor === "nvidia" ? `${r.info.granted_balance} RPM` : `${r.info.granted_balance} ${r.info.currency || ""}`.trim() : "—" })
            ] })
          ] }),
          /* @__PURE__ */ e("p", { className: "sc-meter__sub", children: Ai(r.vendor, r.info, r.balance) })
        ] }),
        /* @__PURE__ */ e("p", { className: "mk-hint", style: { margin: "12px 0" }, children: y.last ? `最近一次：${y.last.at || ""} · prompt ${y.last.prompt_tokens}（命中 ${y.last.prompt_cache_hit_tokens || 0} / ${y.last.cache_hit_rate_percent ?? "—"}%）· completion ${y.last.completion_tokens} · ${y.last.model || ""}` : "暂无本地用量记录" }),
        /* @__PURE__ */ o("div", { className: "mk-btn-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", disabled: r.balanceLoading, onClick: () => void r.loadBalance(!0), children: r.balanceLoading ? "查询中…" : r.labels.refreshBtn }),
          /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost", onClick: () => void r.clearUsage(), children: "清空本地用量账本" })
        ] })
      ] })
    ] }) : null,
    n === "policy" ? /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-2", children: [
      /* @__PURE__ */ e("h2", { className: "panel-title", children: "对话行为" }),
      /* @__PURE__ */ o("div", { className: "form-grid", children: [
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "防抖 (ms)" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1e3, max: 12e4, value: r.context.debounceMs, onChange: (s) => r.setContext((p) => ({ ...p, debounceMs: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "最大合并条数" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 25, value: r.context.maxBatch, onChange: (s) => r.setContext((p) => ({ ...p, maxBatch: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "随机等待" }),
          /* @__PURE__ */ o("select", { className: "mk-input", value: r.context.randomWaitEnabled ? "on" : "off", onChange: (s) => r.setContext((p) => ({ ...p, randomWaitEnabled: s.target.value === "on" })), children: [
            /* @__PURE__ */ e("option", { value: "on", children: "开启（每条消息重抽）" }),
            /* @__PURE__ */ e("option", { value: "off", children: "关闭（用固定防抖）" })
          ] })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "随机等待下限 (分钟)" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 60, value: r.context.randomWaitMinMin, onChange: (s) => r.setContext((p) => ({ ...p, randomWaitMinMin: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "随机等待上限 (分钟)" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 60, value: r.context.randomWaitMaxMin, onChange: (s) => r.setContext((p) => ({ ...p, randomWaitMaxMin: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "连发间隔 (ms)" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 400, max: 8e3, step: 100, value: r.context.replyGapMs, onChange: (s) => r.setContext((p) => ({ ...p, replyGapMs: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "闭嘴上限" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 50, value: r.context.shutUpLimit, onChange: (s) => r.setContext((p) => ({ ...p, shutUpLimit: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "没人对你说话时闭嘴 (%)" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 0, max: 100, step: 5, value: r.context.silenceVetoPercent, onChange: (s) => r.setContext((p) => ({ ...p, silenceVetoPercent: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "行为下限" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 0, max: 10, value: r.context.actionMin, onChange: (s) => r.setContext((p) => ({ ...p, actionMin: Number(s.target.value) })) })
        ] }),
        /* @__PURE__ */ o("div", { className: "field", children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "行为上限" }),
          /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 10, value: r.context.actionMax, onChange: (s) => r.setContext((p) => ({ ...p, actionMax: Number(s.target.value) })) })
        ] })
      ] }),
      /* @__PURE__ */ o("div", { className: "field", style: { marginTop: 12 }, children: [
        /* @__PURE__ */ o("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", style: { margin: 0 }, children: "【你是谁】（全局人格）" }),
          /* @__PURE__ */ e(
            "button",
            {
              type: "button",
              className: "mk-btn mk-btn--ghost mk-btn--sm",
              onClick: () => {
                (async () => await t({
                  title: "恢复内置默认",
                  message: "将全局人格恢复为插件内置默认？群/好友若未设独立人设会跟随后续保存生效。未保存的修改会丢失（仍需点「保存」才会写入）。",
                  okText: "恢复"
                }) && (r.setContext((p) => ({ ...p, systemPrompt: r.defaultPrompt || p.systemPrompt })), i("已恢复内置默认（请保存生效）", "ok")))();
              },
              children: "恢复默认"
            }
          )
        ] }),
        /* @__PURE__ */ e(
          "textarea",
          {
            className: "mk-input mk-input--prompt",
            rows: 6,
            maxLength: 1200,
            value: r.context.systemPrompt,
            onChange: (s) => {
              const p = s.target.value.slice(0, 1200);
              r.setContext((g) => ({ ...g, systemPrompt: p }));
            },
            placeholder: "你是群里的「喵喵」：可爱却很欠的傲娇小恶魔少女……"
          }
        ),
        /* @__PURE__ */ o("p", { className: "mk-hint", style: { margin: "4px 0 0", textAlign: "right" }, children: [
          (r.context.systemPrompt || "").length,
          "/1200 · 最多 1200 字"
        ] })
      ] }),
      /* @__PURE__ */ e("div", { className: "mk-btn-row", style: { marginTop: 12 }, children: /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", onClick: () => void r.saveConfig(), children: "保存" }) })
    ] }) : null,
    n === "skills" ? /* @__PURE__ */ o(ne, { children: [
      /* @__PURE__ */ o("details", { className: "fold-panel stagger-item stagger-2", children: [
        /* @__PURE__ */ o("summary", { className: "fold-panel__summary", children: [
          /* @__PURE__ */ e("span", { children: "工具技能" }),
          /* @__PURE__ */ o("span", { className: "fold-panel__meta", children: [
            r.toolSkills.length,
            " 项"
          ] })
        ] }),
        /* @__PURE__ */ e("div", { className: "fold-panel__body", children: /* @__PURE__ */ o("div", { className: "sc-kb-list", children: [
          r.toolSkills.map((s) => /* @__PURE__ */ o("div", { className: "sc-kb-row", children: [
            /* @__PURE__ */ o("div", { className: "sc-kb-row__main", children: [
              /* @__PURE__ */ e("strong", { children: s.title || s.code }),
              /* @__PURE__ */ e("p", { className: "mk-hint", style: { margin: "4px 0 0" }, children: s.when || s.params || "" })
            ] }),
            /* @__PURE__ */ o("label", { className: "toggle-switch", children: [
              /* @__PURE__ */ e("input", { type: "checkbox", checked: !!s.enabled, onChange: (p) => void r.toggleTool(s.code, p.target.checked) }),
              /* @__PURE__ */ e("span", { className: "toggle-slider" })
            ] })
          ] }, s.code)),
          r.toolSkills.length ? null : /* @__PURE__ */ e("div", { className: "mk-state", children: "暂无工具技能" })
        ] }) })
      ] }),
      /* @__PURE__ */ o("details", { className: "fold-panel stagger-item stagger-3", children: [
        /* @__PURE__ */ o("summary", { className: "fold-panel__summary", children: [
          /* @__PURE__ */ e("span", { children: "表情图库" }),
          /* @__PURE__ */ e("span", { className: "fold-panel__meta", children: r.galleryReady ? "已就绪" : "未就绪" })
        ] }),
        /* @__PURE__ */ o("div", { className: "fold-panel__body", children: [
          /* @__PURE__ */ e("p", { className: "mk-hint", style: { margin: "0 0 12px" }, children: r.galleryReady ? "图库服务已就绪" : "需安装图库后可用" }),
          /* @__PURE__ */ o("div", { className: "sc-sticker-gallery-list", children: [
            r.galleries.map((s) => {
              const p = s.activeJob, g = Wa(p), _ = Ne(p?.percent), C = p?.downloadedBytes ?? p?.downloaded, P = p?.totalBytes ?? p?.total, $ = p?.status === "extracting" ? "解压中" : g ? "下载中" : s.installed ? `已安装 · ${s.imageCount ?? 0} 张` : "未安装";
              return /* @__PURE__ */ o("div", { className: "sc-sticker-card", children: [
                /* @__PURE__ */ o("div", { className: "sc-sticker-card__top", children: [
                  /* @__PURE__ */ e("strong", { children: s.name || s.id }),
                  /* @__PURE__ */ e("span", { children: $ })
                ] }),
                g ? /* @__PURE__ */ o("div", { className: "sc-sticker-progress is-on", children: [
                  /* @__PURE__ */ e("div", { className: "sc-sticker-progress__track", children: /* @__PURE__ */ e("div", { className: "sc-sticker-progress__fill", style: { width: `${_.toFixed(1)}%` } }) }),
                  /* @__PURE__ */ e("p", { className: "sc-sticker-progress__meta", children: p?.status === "extracting" ? "正在解压覆盖安装…" : `${Ka(p?.percent)} · ${Ze(C)} / ${Ze(P)} · ${zi(p?.speedBps)} · ${Ti(p?.etaSec)}` })
                ] }) : null,
                p?.error ? /* @__PURE__ */ e("p", { className: "mk-hint", style: { color: "#dc2626" }, children: p.error }) : null,
                !g && p?.source ? /* @__PURE__ */ o("p", { className: "sc-sticker-card__source", children: [
                  "上次安装源：",
                  ia(p.source)
                ] }) : null,
                /* @__PURE__ */ e("div", { className: "mk-btn-row", children: /* @__PURE__ */ e(
                  "button",
                  {
                    type: "button",
                    className: "mk-btn mk-btn--primary mk-btn--sm",
                    disabled: !!g,
                    onClick: () => void r.installGallery(s.id),
                    children: g ? "安装中…" : s.installed ? "重新安装" : "安装"
                  }
                ) })
              ] }, s.id);
            }),
            r.galleries.length ? null : /* @__PURE__ */ e("div", { className: "mk-state", children: "暂无图库定义" })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ e(Ba, { open: !!l, onClose: () => c(null), children: /* @__PURE__ */ o(
        "div",
        {
          className: "mk-modal mk-modal--enter sc-source-modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "选择安装源",
          onClick: (s) => s.stopPropagation(),
          children: [
            /* @__PURE__ */ e("h3", { className: "mk-modal__title", children: "选择安装源" }),
            /* @__PURE__ */ o("p", { className: "mk-hint", style: { margin: "0 0 14px" }, children: [
              "即将安装「",
              l?.gallery.name || l?.gallery.id,
              "」，请选择从哪个源下载。"
            ] }),
            /* @__PURE__ */ e("div", { className: "sc-source-list", role: "radiogroup", "aria-label": "安装源", children: ea.map((s) => {
              const p = l?.selected === s.id;
              return /* @__PURE__ */ o(
                "button",
                {
                  type: "button",
                  role: "radio",
                  "aria-checked": p,
                  className: `sc-source-opt${p ? " is-active" : ""}`,
                  onClick: () => u((g) => g && { ...g, selected: s.id }),
                  children: [
                    /* @__PURE__ */ e("span", { className: "sc-source-opt__radio", "aria-hidden": "true" }),
                    /* @__PURE__ */ o("span", { className: "sc-source-opt__body", children: [
                      /* @__PURE__ */ e("strong", { className: "sc-source-opt__label", children: s.label }),
                      /* @__PURE__ */ e("span", { className: "sc-source-opt__desc", children: s.desc })
                    ] })
                  ]
                },
                s.id
              );
            }) }),
            /* @__PURE__ */ o("div", { className: "mk-btn-row", children: [
              /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "mk-btn mk-btn--primary",
                  onClick: () => {
                    const s = l?.selected || aa;
                    c(s);
                  },
                  children: "开始安装"
                }
              ),
              /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost", onClick: () => c(null), children: "取消" })
            ] })
          ]
        }
      ) }),
      /* @__PURE__ */ o("details", { className: "fold-panel stagger-item stagger-4", children: [
        /* @__PURE__ */ o("summary", { className: "fold-panel__summary", children: [
          /* @__PURE__ */ e("span", { children: "联网与识别" }),
          /* @__PURE__ */ e("span", { className: "fold-panel__meta", children: "参数 / Key" })
        ] }),
        /* @__PURE__ */ o("div", { className: "fold-panel__body", children: [
          /* @__PURE__ */ o("div", { className: "sc-param-box", children: [
            /* @__PURE__ */ e("strong", { className: "sc-param-box__title", children: "识别图片参数" }),
            /* @__PURE__ */ o("div", { className: "sc-param-grid", children: [
              /* @__PURE__ */ o("div", { className: "field", children: [
                /* @__PURE__ */ e("label", { className: "mk-label", children: "工具轮上限" }),
                /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 5, value: r.online.toolsMaxRounds, onChange: (s) => r.setOnline((p) => ({ ...p, toolsMaxRounds: Number(s.target.value) })) })
              ] }),
              /* @__PURE__ */ o("div", { className: "field", children: [
                /* @__PURE__ */ e("label", { className: "mk-label", children: "超时（秒）" }),
                /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 5, max: 120, value: r.online.imageRecognize.timeout_sec, onChange: (s) => r.setOnline((p) => ({ ...p, imageRecognize: { ...p.imageRecognize, timeout_sec: Number(s.target.value) } })) })
              ] }),
              /* @__PURE__ */ o("div", { className: "field", children: [
                /* @__PURE__ */ e("label", { className: "mk-label", children: "普通排队上限" }),
                /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 20, value: r.online.imageRecognize.queue_normal, onChange: (s) => r.setOnline((p) => ({ ...p, imageRecognize: { ...p.imageRecognize, queue_normal: Number(s.target.value) } })) })
              ] }),
              /* @__PURE__ */ o("div", { className: "field", children: [
                /* @__PURE__ */ e("label", { className: "mk-label", children: "艾特排队上限" }),
                /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 20, value: r.online.imageRecognize.queue_at, onChange: (s) => r.setOnline((p) => ({ ...p, imageRecognize: { ...p.imageRecognize, queue_at: Number(s.target.value) } })) })
              ] }),
              /* @__PURE__ */ o("div", { className: "field", children: [
                /* @__PURE__ */ e("label", { className: "mk-label", children: "普通单条最多" }),
                /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 10, value: r.online.imageRecognize.per_msg_normal, onChange: (s) => r.setOnline((p) => ({ ...p, imageRecognize: { ...p.imageRecognize, per_msg_normal: Number(s.target.value) } })) })
              ] }),
              /* @__PURE__ */ o("div", { className: "field", children: [
                /* @__PURE__ */ e("label", { className: "mk-label", children: "艾特单条最多" }),
                /* @__PURE__ */ e("input", { type: "number", className: "mk-input", min: 1, max: 10, value: r.online.imageRecognize.per_msg_at, onChange: (s) => r.setOnline((p) => ({ ...p, imageRecognize: { ...p.imageRecognize, per_msg_at: Number(s.target.value) } })) })
              ] })
            ] })
          ] }),
          /* @__PURE__ */ e("div", { className: "sc-provider-grid", style: { marginTop: 16 }, children: r.providers.map((s) => {
            const p = Ri(s.id, r.cfg, r.clearFlags), g = r.cfg.web_search_masked?.[`${s.id}_key`];
            return /* @__PURE__ */ o("div", { className: `sc-provider-card${p ? " is-configured" : ""}`, children: [
              /* @__PURE__ */ o("div", { className: "sc-provider-card__top", children: [
                /* @__PURE__ */ e("strong", { children: s.name }),
                /* @__PURE__ */ e("span", { className: "sc-provider-card__badge", children: p ? "已配置" : "未配置" })
              ] }),
              /* @__PURE__ */ o("p", { className: "sc-provider-card__links", children: [
                "获取 Key：",
                /* @__PURE__ */ e("a", { href: s.home, target: "_blank", rel: "noopener noreferrer", children: s.home }),
                s.docs ? /* @__PURE__ */ o(ne, { children: [
                  " · ",
                  /* @__PURE__ */ e("a", { href: s.docs, target: "_blank", rel: "noopener noreferrer", children: "文档" })
                ] }) : null
              ] }),
              /* @__PURE__ */ e(
                "input",
                {
                  type: "text",
                  className: "mk-input mk-input--secret sc-provider-key",
                  name: `mkai-ws-${s.id}`,
                  placeholder: p ? `已配置 ${g || ""}（留空不修改）` : "粘贴 API Key",
                  autoComplete: "off",
                  autoCorrect: "off",
                  spellCheck: !1,
                  "data-lpignore": "true",
                  "data-1p-ignore": "true",
                  "data-form-type": "other",
                  value: r.online.keys[s.id],
                  onChange: (_) => r.setOnline((C) => ({ ...C, keys: { ...C.keys, [s.id]: _.target.value } }))
                }
              ),
              /* @__PURE__ */ o("div", { className: "mk-btn-row", style: { marginTop: 8 }, children: [
                /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost mk-btn--sm", onClick: () => void r.testWebSearch(s.id), children: "测试" }),
                /* @__PURE__ */ e(
                  "button",
                  {
                    type: "button",
                    className: "mk-btn mk-btn--ghost mk-btn--sm",
                    onClick: () => {
                      r.setClearFlags((_) => ({ ..._, [s.id]: !0 })), r.setOnline((_) => ({ ..._, keys: { ..._.keys, [s.id]: "" } })), i("已标记清空，请点「保存联网配置」生效");
                    },
                    children: "清空 Key"
                  }
                ),
                /* @__PURE__ */ e("span", { className: `sc-provider-card__status${r.providerStatus[s.id].includes("正常") ? " is-ok" : r.providerStatus[s.id] && r.providerStatus[s.id] !== "测试中…" ? " is-err" : ""}`, children: r.providerStatus[s.id] })
              ] })
            ] }, s.id);
          }) }),
          /* @__PURE__ */ e("div", { className: "mk-btn-row", style: { marginTop: 14 }, children: /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", onClick: () => void r.saveOnline(), children: "保存联网配置" }) })
        ] })
      ] })
    ] }) : null,
    n === "rotation" ? /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-2", children: [
      /* @__PURE__ */ e("h2", { className: "panel-title", children: "模型轮替" }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "是否开启自动轮替" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "默认关闭；开启后 API 访问报错会按下面的方式自动换模型重试" })
        ] }),
        /* @__PURE__ */ o("label", { className: "toggle-switch", "aria-label": "是否开启自动轮替", children: [
          /* @__PURE__ */ e(
            "input",
            {
              type: "checkbox",
              checked: r.rotation.enabled,
              onChange: (s) => r.setRotation((p) => ({ ...p, enabled: s.target.checked }))
            }
          ),
          /* @__PURE__ */ e("span", { className: "toggle-slider" })
        ] })
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "切换方式" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "右侧为轮替次数上限，0 = 不限，把候选全试完才算失败" })
        ] }),
        /* @__PURE__ */ e(
          "input",
          {
            type: "number",
            className: "mk-input sc-rot-limit",
            min: 0,
            max: 20,
            step: 1,
            value: r.rotation.limit,
            "aria-label": "轮替次数上限",
            onChange: (s) => {
              const p = Math.min(20, Math.max(0, Math.round(Number(s.target.value) || 0)));
              r.setRotation((g) => ({ ...g, limit: p }));
            }
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "seg seg--center sc-rot-seg", ref: h.navRef, children: [
        /* @__PURE__ */ e(
          "div",
          {
            className: `nav-liquid${h.box.ready ? " is-ready" : ""}`,
            style: {
              transform: `translate3d(${h.box.left}px, ${h.box.top}px, 0)`,
              width: h.box.width,
              height: h.box.height
            },
            "aria-hidden": !0
          }
        ),
        Ve.map((s, p) => /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            ref: (g) => h.setItemRef(p, g),
            className: `seg__btn${r.rotation.mode === s.value ? " is-active" : ""}`,
            title: s.full,
            onClick: () => r.setRotation((g) => ({ ...g, mode: s.value })),
            children: s.label
          },
          s.value
        ))
      ] }),
      /* @__PURE__ */ e("div", { className: "sc-rot-notes", children: Ei.map((s) => /* @__PURE__ */ e("p", { className: "mk-hint sc-rot-notes__line", children: s }, s)) }),
      /* @__PURE__ */ e("div", { className: "mk-btn-row", style: { marginTop: 12 }, children: /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "mk-btn mk-btn--primary",
          disabled: r.rotationSaving,
          onClick: () => void r.saveRotation(),
          children: r.rotationSaving ? "保存中…" : "保存"
        }
      ) })
    ] }) : null
  ] });
}
const ta = "rgba(148, 163, 184, 0.22)";
function Le(a, i, t, n) {
  const l = n * Math.PI / 180;
  return [a + t * Math.cos(l), i + t * Math.sin(l)];
}
function Qi(a, i, t, n, l, u) {
  u - l >= 359.99 && (u = l + 359.99);
  const d = u - l > 180 ? 1 : 0, [m, c] = Le(a, i, t, l), [r, x] = Le(a, i, t, u), k = t - n, [h, y] = Le(a, i, k, u), [s, p] = Le(a, i, k, l);
  return [
    `M ${m} ${c}`,
    `A ${t} ${t} 0 ${d} 1 ${r} ${x}`,
    `L ${h} ${y}`,
    `A ${k} ${k} 0 ${d} 0 ${s} ${p}`,
    "Z"
  ].join(" ");
}
function va({
  segments: a,
  size: i = 132,
  thickness: t = 16,
  centerNum: n,
  centerSub: l,
  interactive: u = !1,
  formatValue: d = (c) => String(Math.round(c)),
  ariaLabel: m = "构成环形图，点击色块查看占比"
}) {
  const [c, r] = v(null), x = a.reduce((K, A) => K + Math.max(0, A.value), 0), k = (i - t) / 2, h = i / 2, y = Z(() => {
    let K = -90;
    return a.map((A, U) => {
      const F = Math.max(0, A.value), G = x > 0 && F > 0 ? F / x * 360 : 0, H = K, L = K + G;
      return K = L, { seg: A, i: U, start: H, end: L, sweep: G, val: F };
    });
  }, [a, x]), s = E((K) => {
    u && r((A) => A === K ? null : K);
  }, [u]), p = c != null ? y[c] : null, g = u && p ? d(p.val) : n, _ = u && p && p.seg.label ? `${p.seg.label} · ${x > 0 ? Math.round(p.val / x * 100) : 0}%` : l, C = `mk-chart mk-chart--donut${u ? " mk-chart--donut-interactive" : ""}`, P = { "--mk-donut-px": i };
  if (u)
    return /* @__PURE__ */ o(
      "svg",
      {
        viewBox: `0 0 ${i} ${i}`,
        width: i,
        height: i,
        className: C,
        style: P,
        role: "img",
        "aria-label": m,
        children: [
          /* @__PURE__ */ e("circle", { cx: h, cy: h, r: k, fill: "none", stroke: ta, strokeWidth: t }),
          x > 0 && y.map(({ seg: K, i: A, start: U, end: F, sweep: G, val: H }) => {
            if (G <= 0) return null;
            const L = c === A, w = c != null && !L;
            return /* @__PURE__ */ e(
              "path",
              {
                d: Qi(h, h, k, t, U, F),
                fill: K.color,
                className: `mk-chart__seg${L ? " is-active" : ""}${w ? " is-dim" : ""}`,
                role: "button",
                tabIndex: 0,
                "aria-label": K.label ? `${K.label} ${d(H)}` : void 0,
                onClick: () => s(A),
                onKeyDown: (M) => {
                  (M.key === "Enter" || M.key === " ") && (M.preventDefault(), s(A));
                }
              },
              A
            );
          }),
          g != null && g !== "" && /* @__PURE__ */ e("text", { x: h, y: h, className: "mk-chart__num", textAnchor: "middle", dominantBaseline: "central", dy: _ ? "-0.15em" : "0", children: g }),
          _ != null && _ !== "" && /* @__PURE__ */ e("text", { x: h, y: h, className: "mk-chart__sub", textAnchor: "middle", dominantBaseline: "central", dy: "1.15em", children: _ })
        ]
      }
    );
  const $ = 2 * Math.PI * k;
  let W = 0;
  return /* @__PURE__ */ o(
    "svg",
    {
      viewBox: `0 0 ${i} ${i}`,
      width: i,
      height: i,
      className: C,
      style: P,
      role: "img",
      children: [
        /* @__PURE__ */ e("circle", { cx: h, cy: h, r: k, fill: "none", stroke: ta, strokeWidth: t }),
        x > 0 && a.map((K, A) => {
          const U = Math.max(0, K.value) / x * $, F = /* @__PURE__ */ e(
            "circle",
            {
              cx: h,
              cy: h,
              r: k,
              fill: "none",
              stroke: K.color,
              strokeWidth: t,
              strokeDasharray: `${U} ${$ - U}`,
              strokeDashoffset: -W,
              transform: `rotate(-90 ${h} ${h})`
            },
            A
          );
          return W += U, F;
        }),
        n != null && /* @__PURE__ */ e("text", { x: h, y: h, className: "mk-chart__num", textAnchor: "middle", dominantBaseline: "central", dy: "-0.15em", children: n }),
        l != null && /* @__PURE__ */ e("text", { x: h, y: h, className: "mk-chart__sub", textAnchor: "middle", dominantBaseline: "central", dy: "1.15em", children: l })
      ]
    }
  );
}
function _a({
  value: a,
  max: i = 100,
  size: t = 148,
  thickness: n = 13,
  tone: l = "var(--mk-accent)",
  centerNum: u,
  centerSub: d
}) {
  const m = i > 0 ? Math.max(0, Math.min(1, a / i)) : 0, c = (t - n) / 2, r = t / 2, x = t / 2, k = (P) => {
    const $ = P * Math.PI / 180;
    return [r - c * Math.cos($), x - c * Math.sin($)];
  }, [h, y] = k(0), [s, p] = k(180), [g, _] = k(180 * m), C = Math.ceil(x + n / 2 + 1);
  return /* @__PURE__ */ o("svg", { viewBox: `0 0 ${t} ${C}`, width: t, height: C, className: "mk-chart mk-chart--gauge", role: "img", children: [
    /* @__PURE__ */ e("path", { d: `M ${h} ${y} A ${c} ${c} 0 0 1 ${s} ${p}`, fill: "none", stroke: ta, strokeWidth: n, strokeLinecap: "round" }),
    m > 0 && /* @__PURE__ */ e("path", { d: `M ${h} ${y} A ${c} ${c} 0 0 1 ${g} ${_}`, fill: "none", stroke: l, strokeWidth: n, strokeLinecap: "round" }),
    u != null && /* @__PURE__ */ e("text", { x: r, y: x, className: "mk-chart__num", textAnchor: "middle", dy: "-0.35em", children: u }),
    d != null && /* @__PURE__ */ e("text", { x: r, y: x, className: "mk-chart__sub", textAnchor: "middle", dy: "0.7em", children: d })
  ] });
}
function Ye({
  data: a,
  max: i,
  barColor: t = "var(--mk-accent)",
  format: n
}) {
  const l = i ?? Math.max(1, ...a.map((u) => u.value));
  return /* @__PURE__ */ e("div", { className: "mk-minibar", children: a.map((u, d) => /* @__PURE__ */ o("div", { className: "mk-minibar__row", children: [
    /* @__PURE__ */ e("span", { className: "mk-minibar__label", title: u.hint || u.label, children: u.label }),
    /* @__PURE__ */ e("span", { className: "mk-minibar__track", children: /* @__PURE__ */ e(
      "span",
      {
        className: "mk-minibar__fill",
        style: { width: `${l > 0 ? Math.max(0, Math.min(100, u.value / l * 100)) : 0}%`, background: u.color || t }
      }
    ) }),
    /* @__PURE__ */ e("span", { className: "mk-minibar__val", children: n ? n(u.value) : u.value })
  ] }, d)) });
}
const Ga = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\]\s+/, Va = /^\[眼睛\s+msgid:(\S+)\s+第(\d+)张\]:\s*(.*)$/i, Ya = /^补充：(\S+)\s*图片第(\d+)张解析结果\s*(.*)$/i, ya = /\d{5,20}\s*发了\d+张\[图片\][^\n]*/g, Wi = /(?:\(|（)?图片资源正在解析[^)\n）]*(?:\)|）)?/g;
function Gi(a) {
  return /^\d{5,20}\s*发了\d+张\[图片\]/i.test(String(a || "").trim());
}
function Vi(a) {
  const i = String(a || ""), t = ya.test(i);
  return { text: i.replace(ya, "").replace(Wi, "").replace(/\(\s*\)/g, "").replace(/\n{2,}/g, `
`).trim(), hadImagePlaceholder: t };
}
function ra(a, i) {
  const { text: t, hadImagePlaceholder: n } = Vi(a);
  return t || (n || i ? "[图片]" : "（空消息）");
}
function Ha(a) {
  return String(a || "").replace(/<memory-recall>[\s\S]*?<\/memory-recall>/gi, "").replace(/<host-state>[\s\S]*?<\/host-state>/gi, "").replace(/<skill-tree>[\s\S]*?<\/skill-tree>/gi, "").replace(/<\/?(?:batch-messages|main-visit|side-context|compaction-summary)>/gi, `
`).replace(/（(?:主访问|次访问)[^）]*）\n?/g, "").replace(/\[compact[^\]]*\]\n?/gi, "").replace(/说明：以下为远史压缩[\s\S]*?(?=\n\[|\n<main-visit|\n<batch-messages|$)/gi, "").replace(/<\/?digest-(?:stance|users|assistants)>/gi, `
`);
}
function Yi(a) {
  if (!a.startsWith("[")) return null;
  for (let i = 1; i < a.length; i += 1) {
    if (a[i] !== "]") continue;
    const t = a.slice(i + 1);
    if (/^\s*(?:\[|:|$)/.test(t))
      return { inner: a.slice(1, i), rest: t.trimStart() };
  }
  return null;
}
function Hi(a) {
  let i = String(a || "").trimStart();
  const t = [];
  for (; i.startsWith("["); ) {
    const l = Yi(i);
    if (!l) return null;
    t.push(l.inner), i = l.rest.trimStart();
  }
  if (!i.startsWith(":")) return null;
  const n = i.replace(/^:\s?/, "");
  return { tags: t, body: n };
}
function Ji(a) {
  if (a.includes("群主")) return "owner";
  if (a.includes("管理")) return "admin";
  if (a.includes("成员")) return "member";
}
function Xi(a) {
  for (const i of a) {
    const t = i.match(/^头衔:(.+)$/);
    if (t) {
      const n = String(t[1] || "").trim();
      if (n) return n;
    }
  }
}
function Zi(a) {
  for (const i of a) {
    const t = i.match(/^msgid:(.+)$/i);
    if (t) return String(t[1] || "").trim();
  }
  return "";
}
function et(a) {
  const i = String(a || "").replace(/^引用→/, "").trim();
  if (!i) return "引用消息";
  const t = i.match(/「([^」]*)」/), n = i.replace(/\s*「[^」]*」\s*$/, "").trim();
  return t && n ? `引用 ${n}：${t[1]}` : t ? `引用：${t[1]}` : `引用 ${n || i}`;
}
function wa(a) {
  const i = String(a || "").replace(/^艾特:/, "").trim();
  return i ? `@ ${i}` : "@";
}
function at(a) {
  let i, t;
  for (const n of a)
    n.startsWith("引用→") ? i = et(n) : n.startsWith("艾特:") && (t = t ? `${t}、${wa(n).replace(/^@ /, "")}` : wa(n));
  return { groupRole: Ji(a), groupTitle: Xi(a), replyTo: i, atTargets: t };
}
function it(a) {
  const i = String(a || "").match(/^(\d{5,20})\s*发了\d+张\[图片\]/);
  return i ? String(i[1] || "").trim() : "";
}
function tt(a, i = 280) {
  const t = String(a).trim();
  return t ? t.length > i ? `${t.slice(0, i)}…` : t : "";
}
function Re(a, i, t, n) {
  const l = String(i || "").trim();
  if (!l) return;
  const u = Math.max(1, Number(t) || 1), d = tt(n || "（图片）");
  if (!d) return;
  a.has(l) || a.set(l, /* @__PURE__ */ new Map()), a.get(l).set(u, d);
}
function rt(a) {
  const i = /* @__PURE__ */ new Map();
  for (const t of a || []) {
    const n = String(t.role || "").toLowerCase();
    if (n !== "user" && n !== "human") continue;
    const l = Ha(String(t.content || ""));
    for (const u of l.split(/\n+/)) {
      const d = u.trim();
      if (!d) continue;
      let m = d.match(Va);
      if (m) {
        Re(i, m[1], Number(m[2]), m[3] || "");
        continue;
      }
      if (m = d.match(Ya), m) {
        Re(i, m[1], Number(m[2]), m[3] || "");
        continue;
      }
      for (const c of d.matchAll(/\[眼睛\s+msgid:(\S+)\s+第(\d+)张\]:\s*([^\n\[]*)/gi))
        Re(i, c[1], Number(c[2]), c[3] || "");
      for (const c of d.matchAll(/补充：(\S+)\s*图片第(\d+)张解析结果\s*([^\n]*)/gi))
        Re(i, c[1], Number(c[2]), c[3] || "");
    }
  }
  return i;
}
function Ja(a, i) {
  const t = String(i || "").trim();
  if (!t || !a.has(t)) return [];
  const n = a.get(t), l = [...n.keys()].sort((u, d) => u - d);
  return l.length === 1 ? [n.get(l[0])] : l.map((u) => `第${u}张：${n.get(u)}`);
}
function Na(a) {
  const i = String(a || "").trim();
  return Va.test(i) || Ya.test(i);
}
function nt(a) {
  const i = a.match(Ga);
  if (!i) return null;
  const t = i[1].replace("T", " "), n = a.slice(i[0].length), l = n.match(/^(.+?)\((\d{5,15})\)\s+/);
  if (!l) return null;
  const u = String(l[1] || "").trim(), d = l[2], m = Hi(n.slice(l[0].length));
  if (!m) return null;
  let c = m.body.trim();
  if (/^补充：\S*\s*图片第\d+张解析结果/i.test(c) || /^\[眼睛\s+msgid:/i.test(c))
    return null;
  const r = Zi(m.tags) || it(c);
  return {
    name: u || d,
    qq: d,
    time: t,
    text: ra(c, r),
    kind: "msg",
    messageId: r || void 0,
    ...at(m.tags)
  };
}
function ot(a) {
  return [...a].sort((i, t) => {
    const n = String(i.time || ""), l = String(t.time || "");
    if (n && l && n !== l) return n.localeCompare(l);
    const u = String(i.messageId || ""), d = String(t.messageId || "");
    return u && d && u !== d ? u.localeCompare(d, void 0, { numeric: !0 }) : 0;
  });
}
function st(a, i, t, n) {
  const u = Ha(a).split(/\n+/), d = [];
  for (const c of u) {
    const r = c.trim();
    if (!r || /^\[compact/i.test(r) || r.startsWith("说明：") || r.startsWith("（已并入") || /^[-•·]\s/.test(r) && r.length < 120 || Na(r)) continue;
    const x = nt(r);
    if (x) {
      d.push(x);
      continue;
    }
    if (!Na(r) && !Gi(r) && !Ga.test(r) && d.length && !/^</.test(r)) {
      const k = d[d.length - 1];
      k.text.length < 400 && (k.text = ra(`${k.text}
${r}`, k.messageId));
    }
  }
  for (const c of d)
    c.text = ra(c.text, c.messageId);
  const m = [];
  for (const c of ot(d)) {
    const r = c.messageId || "", x = r ? Ja(t, r) : [];
    r && x.length && n.add(r), m.push({
      id: `in-${i.n++}`,
      side: "in",
      ...c,
      imageNotes: x.length ? x : void 0
    });
  }
  return m;
}
function lt(a, i, t) {
  const n = String(a || "").trim();
  if (!n) return [];
  if (/^<shut_up\s*\/?>$/i.test(n) || /^<shut_up\s*\/>/i.test(n) && !/<msg\b/i.test(n))
    return [{
      id: `sys-${t.n++}`,
      side: "sys",
      name: i,
      text: "（沉默旁听）",
      kind: "shut_up"
    }];
  const l = [], u = /<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi;
  let d;
  for (; d = u.exec(n); ) {
    const x = d[1] || "";
    let k = String(d[2] || "").trim();
    const h = x.match(/\bsticker\s*=\s*"([^"]+)"/i);
    h && l.push({
      id: `out-${t.n++}`,
      side: "out",
      name: i,
      text: `[表情包] ${h[1]}`,
      kind: "sticker"
    }), k && l.push({
      id: `out-${t.n++}`,
      side: "out",
      name: i,
      text: k,
      kind: "msg"
    });
  }
  const m = /<voice>([\s\S]*?)<\/voice>/gi;
  for (; d = m.exec(n); ) {
    const x = String(d[1] || "").trim();
    l.push({
      id: `out-${t.n++}`,
      side: "out",
      name: i,
      text: x ? `[语音]${x}` : "[语音]",
      kind: "voice"
    });
  }
  const c = /<sticker>([\s\S]*?)<\/sticker>/gi;
  for (; d = c.exec(n); )
    l.push({
      id: `out-${t.n++}`,
      side: "out",
      name: i,
      text: `[表情包] ${String(d[1] || "").trim()}`,
      kind: "sticker"
    });
  const r = /<react\b[^>]*emoji\s*=\s*"([^"]+)"[^>]*\/?>/gi;
  for (; d = r.exec(n); )
    l.push({
      id: `out-${t.n++}`,
      side: "out",
      name: i,
      text: `贴了表情 ${d[1]}`,
      kind: "react"
    });
  if (!l.length && !/<replies|/i.test(n)) {
    const x = n.replace(/<\/?[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    x && l.push({
      id: `out-${t.n++}`,
      side: "out",
      name: i,
      text: x.slice(0, 500),
      kind: "msg"
    });
  }
  return l;
}
function dt(a) {
  const i = String(a?.bot_card || a?.bot_nickname || "机器人").trim() || "机器人", t = Array.isArray(a?.messages) ? a.messages : [], n = { n: 1 }, l = [], u = rt(t), d = /* @__PURE__ */ new Set();
  for (const m of t) {
    const c = String(m.role || "").toLowerCase(), r = String(m.content || "");
    if (r.trim()) {
      if (c === "assistant" || c === "model" || c === "ai") {
        l.push(...lt(r, i, n));
        continue;
      }
      (c === "user" || c === "human") && (/<compaction-summary>/i.test(r) && l.push({
        id: `sys-${n.n++}`,
        side: "sys",
        name: "系统",
        text: "（远史已压缩，以下为近史）",
        kind: "compact"
      }), l.push(...st(r, n, u, d)));
    }
  }
  for (const [m] of u) {
    if (d.has(m)) continue;
    const c = Ja(u, m);
    c.length && l.push({
      id: `eyes-orphan-${n.n++}`,
      side: "sys",
      name: "识图",
      text: `msgid:${m} · ${c.join(" / ")}`,
      kind: "eyes",
      messageId: m,
      imageNotes: c
    });
  }
  return l;
}
function ct(a) {
  const i = String(a || "").trim();
  return i ? i.slice(0, 1) : "?";
}
function mt(a) {
  return a === "owner" ? "群主" : a === "admin" ? "管理" : a === "member" ? "成员" : "";
}
function Ca(a) {
  const i = String(a || "");
  return i.length <= 16 ? i : `${i.slice(0, 8)}…${i.slice(-4)}`;
}
function Ce(a) {
  return a.group_name ? a.group_name : a.chat_type === "private" ? Ca(a.chatId.replace(/^p_/, "")) : Ca(a.chatId);
}
function pt(a) {
  return a.chat_type === "private" || String(a.chatId).startsWith("p_") ? { kind: "private", id: String(a.group_id || a.chatId.replace(/^p_/, "")).replace(/\D/g, "") } : { kind: "group", id: String(a.group_id || a.chatId.replace(/^g_/, "")).replace(/\D/g, "") };
}
function he(a) {
  return a.chat_type === "private" || String(a.chatId).startsWith("p_");
}
function na(a) {
  return `${a.config_fingerprint || "na"}:${a.chatId}`;
}
function ut(a) {
  return [...a].sort((i, t) => {
    const n = he(i) ? 0 : 1, l = he(t) ? 0 : 1;
    if (n !== l) return n - l;
    const u = i.active ? 0 : 1, d = t.active ? 0 : 1;
    if (u !== d) return u - d;
    const m = Ce(i), c = Ce(t), r = m.localeCompare(c, "zh");
    return r || String(i.chatId).localeCompare(String(t.chatId));
  });
}
function kt({
  api: a,
  toast: i,
  confirm: t
}) {
  const [n, l] = v([]), [u, d] = v(!0), [m, c] = v(""), [r, x] = v(!1), [k, h] = v(!1), [y, s] = v(null), [p, g] = v(null), [_, C] = v(!1), [P, $] = v(""), W = E(async () => {
    d(!0);
    try {
      const L = r ? { includeEmpty: "1" } : void 0, w = await a.get("/smart-chat/sessions", L);
      l(w.data?.list || []);
    } catch (L) {
      i(L instanceof Error ? L.message : String(L), "err");
    } finally {
      d(!1);
    }
  }, [a, r, i]), K = E(async () => {
    if (await t({
      title: "清理空会话",
      message: "将删除无消息、无摘要的幽灵会话文件。有历史内容的会话不受影响。",
      danger: !0,
      okText: "清理"
    })) {
      h(!0);
      try {
        const w = await a.post(
          "/smart-chat/sessions/prune",
          { removeEmptyNamespaces: !0 }
        ), M = Number(w.data?.removedFiles || 0);
        i(M ? `已清理 ${M} 个空会话` : "没有可清理的空会话", "ok"), await W();
      } catch (w) {
        i(w instanceof Error ? w.message : String(w), "err");
      } finally {
        h(!1);
      }
    }
  }, [a, t, W, i]);
  q(() => {
    W();
  }, [W]), q(() => {
    (async () => {
      try {
        const L = await a.get("/smart-chat/config");
        $(String(L.data?.bot_user_id || "").trim());
      } catch {
      }
    })();
  }, [a]);
  const A = Z(() => {
    const L = m.trim().toLowerCase();
    let w = n;
    return r || (w = w.filter((M) => Number(M.messageCount || 0) > 0)), L && (w = w.filter((M) => [
      M.group_name,
      M.chatId,
      M.group_id,
      M.chat_type,
      M.active ? "正常" : "非当前",
      he(M) ? "好友" : "群聊"
    ].join(" ").toLowerCase().includes(L))), ut(w);
  }, [n, m, r]), U = Z(() => dt(p), [p]), F = E(
    async (L) => {
      s(L), g(null), C(!0);
      try {
        const w = { chatId: L.chatId };
        L.config_fingerprint && (w.fingerprint = L.config_fingerprint);
        const M = await a.get("/smart-chat/session", w);
        g(M.data?.session || null);
      } catch (w) {
        i(w instanceof Error ? w.message : String(w), "err"), s(null);
      } finally {
        C(!1);
      }
    },
    [a, i]
  ), G = E(() => {
    s(null), g(null);
  }, []), H = E(
    async (L) => {
      if (await t({
        title: "删除会话",
        message: "确定删除该会话？",
        danger: !0,
        okText: "删除"
      }))
        try {
          if (await a.post("/smart-chat/session/clear", {
            chatId: L.chatId,
            fingerprint: L.config_fingerprint || void 0
          }), i("会话已删除", "ok"), y && na(y) === na(L) && (s(null), g(null)), await t({
            title: "删除其他会话数据",
            message: "是否同时删除该会话在其他配置下的历史数据？此操作不可恢复。",
            danger: !0,
            okText: "一并删除",
            cancelText: "仅删本条"
          })) {
            const I = await a.post(
              "/smart-chat/session/clear-others",
              {
                chatId: L.chatId,
                keepFingerprint: L.config_fingerprint || void 0
              }
            ), O = Number(I.data?.removed || 0);
            i(O ? `已额外删除 ${O} 条其他会话数据` : "没有其他会话数据", "ok");
          }
          await W();
        } catch (M) {
          i(M instanceof Error ? M.message : String(M), "err");
        }
    },
    [y, a, t, W, i]
  );
  return {
    sessions: n,
    loading: u,
    q: m,
    setQ: c,
    showEmpty: r,
    setShowEmpty: x,
    pruning: k,
    active: y,
    detail: p,
    loadingChat: _,
    botUserId: P,
    filtered: A,
    bubbles: U,
    loadSessions: W,
    pruneEmpty: K,
    openChat: F,
    backToList: G,
    deleteSession: H
  };
}
const ye = {
  vendor: "deepseek",
  vendorName: "—",
  modelLabel: "—",
  botNickname: "",
  customVendorCount: 0,
  totalRequests: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitRate: null,
  todayRequests: 0,
  todayTokens: 0,
  estimatedCost: 0,
  balanceLabel: "…",
  balancePct: null,
  balanceAvailable: !1,
  balanceTone: "warn",
  balanceIsRate: !1,
  sessionsTotal: 0,
  sessionsActive: 0,
  sessionsGroup: 0,
  sessionsPrivate: 0,
  totalMessages: 0,
  topSessions: [],
  msgSeries: [],
  groupTotal: 0,
  groupEnabled: 0,
  friendTotal: 0,
  friendEnabled: 0,
  capImage: 0,
  capWeb: 0,
  capSticker: 0,
  toolTotal: 0,
  toolEnabled: 0,
  stickerReady: !1
};
function gt(a) {
  const i = String(a || "").trim();
  return i ? i.split("/").pop() || i : "—";
}
function ft(a) {
  const [i, t] = v(!0), [n, l] = v(ye), u = E(async () => {
    t(!0);
    try {
      const [d, m, c, r, x, k] = await Promise.all([
        a.get("/smart-chat/config").then((S) => S, () => {
        }),
        a.get("/smart-chat/usage").then((S) => S, () => {
        }),
        a.get("/smart-chat/sessions").then((S) => S, () => {
        }),
        a.get("/groups").then((S) => S, () => {
        }),
        a.get("/friends").then((S) => S, () => {
        }),
        a.get("/smart-chat/tool-skills").then((S) => S, () => {
        })
      ]), h = d?.data || {}, y = Se(h), s = be(y, h.custom_vendors || []), p = m?.data || {}, g = c?.data?.list || [], _ = (r?.data?.groups || []).map((S) => String(S.group_id || "")).filter(Boolean), C = (x?.data?.friends || []).map((S) => String(S.user_id || "")).filter(Boolean), P = k?.data?.tools || [], $ = { code: 0, data: { map: {} } }, [W, K] = await Promise.all([
        _.length ? a.get("/smart-chat/switches", { type: "group", ids: _.join(",") }).then((S) => S, () => {
        }) : Promise.resolve($),
        C.length ? a.get("/smart-chat/switches", { type: "friend", ids: C.join(",") }).then((S) => S, () => {
        }) : Promise.resolve($)
      ]), A = W?.data || {}, U = K?.data || {}, F = A.map || {}, G = U.map || {};
      let H = 0, L = 0, w = 0, M = 0, I = 0;
      const O = (S) => {
        S?.enabled && (S.image_recognize && (w += 1), S.web_search && (M += 1), S.sticker_output && (I += 1));
      };
      for (const S of _)
        F[S]?.enabled && (H += 1), O(F[S]);
      for (const S of C)
        G[S]?.enabled && (L += 1), O(G[S]);
      const Q = g.filter((S) => Number(S.messageCount || 0) > 0);
      let ae = 0, te = 0, Y = 0;
      for (const S of Q)
        he(S) ? te += 1 : ae += 1, Y += Number(S.messageCount || 0);
      const X = [...Q].sort(
        (S, V) => Number(V.messageCount || 0) - Number(S.messageCount || 0)
      ), pe = X.slice(0, 5).map((S) => ({ label: Ce(S), value: Number(S.messageCount || 0) })), ie = X.slice(0, 24).map((S) => Number(S.messageCount || 0)).reverse(), J = Di();
      l({
        vendor: y,
        vendorName: String(s?.name || h.vendor || "—"),
        modelLabel: gt(String(h.model || "")),
        botNickname: String(h.bot_nickname || "").trim(),
        customVendorCount: (h.custom_vendors || []).length,
        totalRequests: Number(p.total_requests || 0),
        totalTokens: Number(p.total_tokens || 0),
        promptTokens: Number(p.total_prompt_tokens || 0),
        completionTokens: Number(p.total_completion_tokens || 0),
        cacheHitRate: p.cache_hit_rate_percent ?? null,
        todayRequests: Number(p.today?.requests || 0),
        todayTokens: Number(p.today?.total_tokens || 0),
        estimatedCost: Number(p.total_estimated_cost || 0),
        sessionsTotal: Q.length,
        sessionsActive: Q.filter((S) => S.active).length,
        sessionsGroup: ae,
        sessionsPrivate: te,
        totalMessages: Y,
        topSessions: pe,
        msgSeries: ie,
        groupTotal: _.length,
        groupEnabled: H,
        friendTotal: C.length,
        friendEnabled: L,
        capImage: w,
        capWeb: M,
        capSticker: I,
        toolTotal: P.length,
        toolEnabled: P.filter((S) => S.enabled).length,
        stickerReady: !!A.sticker_gallery_ready,
        balanceLabel: J?.label ?? ye.balanceLabel,
        balancePct: J?.pct ?? ye.balancePct,
        balanceAvailable: J?.available ?? ye.balanceAvailable,
        balanceTone: J?.tone ?? ye.balanceTone,
        balanceIsRate: J?.isRate ?? !1
      }), t(!1);
      try {
        const S = await Qa(a, h, { force: !1 });
        l((V) => ({
          ...V,
          balanceLabel: S.label,
          balancePct: S.pct,
          balanceAvailable: S.available,
          balanceTone: S.tone,
          balanceIsRate: S.isRate
        }));
      } catch {
      }
    } finally {
      t(!1);
    }
  }, [a]);
  return q(() => {
    u();
  }, [u]), { loading: i, stats: n, refresh: u };
}
function Pe(a, i, t) {
  return Math.min(t, Math.max(i, a));
}
function bt(a, i) {
  const t = Math.max(0, a);
  if (i === "mobile") {
    const u = Math.round(Pe(t * 0.82, 68, 112)), d = Math.round(Pe(u * 0.122, 8, 13));
    return { size: u, thickness: d };
  }
  const n = Math.round(Pe(t * 0.78, 100, 176)), l = Math.round(Pe(n * 0.121, 11, 18));
  return { size: n, thickness: l };
}
const ht = { desktop: 20, mobile: 12 }, Sa = 2, $a = {
  desktop: { size: 128, thickness: 15 },
  mobile: { size: 88, thickness: 11 }
};
function xt(a, i) {
  const [t, n] = v(() => $a[i]);
  return q(() => {
    n($a[i]);
  }, [i]), q(() => {
    const l = a.current;
    if (!l) return;
    const u = ht[i], d = () => {
      const r = (l.clientWidth - u * (Sa - 1)) / Sa;
      n(bt(r, i));
    };
    d();
    const m = new ResizeObserver(d);
    return m.observe(l), () => m.disconnect();
  }, [a, i]), t;
}
function Ie(a) {
  const i = Math.abs(a);
  return i >= 1e8 ? (a / 1e8).toFixed(1).replace(/\.0$/, "") + "亿" : i >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, "") + "w" : i >= 1e3 ? (a / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(a));
}
function He(a) {
  const i = Math.abs(a);
  return i >= 1e6 ? (a / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : i >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, "") + "w" : i >= 1e3 ? (a / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(a));
}
function vt(a) {
  return a ? a < 1 ? a.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : a.toFixed(2) : "0";
}
function Ae({ num: a, label: i, sm: t }) {
  return /* @__PURE__ */ o("div", { className: "ov-kpi__cell", children: [
    /* @__PURE__ */ e("span", { className: `ov-kpi__num${t ? " ov-kpi__num--sm" : ""}`, children: a }),
    /* @__PURE__ */ e("span", { className: "ov-kpi__label", children: i })
  ] });
}
function _t({ api: a }) {
  const { loading: i, stats: t } = ft(a), n = Ke(), l = j(null), u = xt(l, n);
  if (i)
    return /* @__PURE__ */ e("section", { className: "mkai-page-overview", children: /* @__PURE__ */ e("div", { className: "ov-grid", children: Array.from({ length: 5 }).map((r, x) => /* @__PURE__ */ e("div", { className: "glass-card ov-card ov-skeleton", style: { animationDelay: `${x * 0.05}s` } }, x)) }) });
  const d = t.groupEnabled + t.friendEnabled, m = [
    { label: "群聊", value: t.groupEnabled, hint: `已开启 ${t.groupEnabled} / 共 ${t.groupTotal}` },
    { label: "好友", value: t.friendEnabled, hint: `已开启 ${t.friendEnabled} / 共 ${t.friendTotal}` }
  ], c = [
    { label: "识图", value: t.capImage, color: "var(--mk-brand-400)" },
    { label: "联网", value: t.capWeb, color: "var(--mk-info)" },
    { label: "表情", value: t.capSticker, color: "var(--mk-brand-600)" }
  ];
  return /* @__PURE__ */ e("section", { className: "mkai-page-overview", children: /* @__PURE__ */ o("div", { className: "ov-grid", children: [
    /* @__PURE__ */ o("article", { className: "glass-card ov-card ov-card--full", children: [
      /* @__PURE__ */ e("div", { className: "mk-panel-head", children: /* @__PURE__ */ e("h3", { className: "ov-card__title", children: "接入信息" }) }),
      /* @__PURE__ */ e("div", { className: "mk-panel-body", children: /* @__PURE__ */ o("dl", { className: "ov-meta", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("dt", { children: "厂商" }),
          /* @__PURE__ */ e("dd", { children: t.vendorName })
        ] }),
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("dt", { children: "模型" }),
          /* @__PURE__ */ e("dd", { title: t.modelLabel, children: t.modelLabel })
        ] }),
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("dt", { children: "人格昵称" }),
          /* @__PURE__ */ e("dd", { children: t.botNickname || "—" })
        ] }),
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("dt", { children: "自定义厂商" }),
          /* @__PURE__ */ e("dd", { children: t.customVendorCount })
        ] }),
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("dt", { children: "工具技能" }),
          /* @__PURE__ */ o("dd", { children: [
            t.toolEnabled,
            "/",
            t.toolTotal
          ] })
        ] }),
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("dt", { children: "表情图库" }),
          /* @__PURE__ */ e("dd", { children: t.stickerReady ? "已就绪" : "未安装" })
        ] })
      ] }) })
    ] }),
    /* @__PURE__ */ o("article", { className: "glass-card ov-card ov-card--full ov-card--usage", children: [
      /* @__PURE__ */ e("div", { className: "mk-panel-head", children: /* @__PURE__ */ e("h3", { className: "ov-card__title", children: "Token 与会话" }) }),
      /* @__PURE__ */ o("div", { className: "mk-panel-body ov-usage-grid", ref: l, children: [
        /* @__PURE__ */ o("section", { className: "ov-usage-col", children: [
          /* @__PURE__ */ e("div", { className: "ov-usage-col__label", children: "Token 构成" }),
          /* @__PURE__ */ e("div", { className: "ov-usage-donut", children: /* @__PURE__ */ e(
            va,
            {
              size: u.size,
              thickness: u.thickness,
              interactive: !0,
              formatValue: He,
              ariaLabel: "Token 构成环形图，点击色块查看占比",
              segments: [
                { value: t.promptTokens, color: "var(--mk-brand-400)", label: "提示" },
                { value: t.completionTokens, color: "var(--mk-brand-700)", label: "补全" }
              ],
              centerNum: He(t.totalTokens)
            }
          ) })
        ] }),
        /* @__PURE__ */ o("section", { className: "ov-usage-col", children: [
          /* @__PURE__ */ e("div", { className: "ov-usage-col__label", children: "会话概况" }),
          /* @__PURE__ */ e("div", { className: "ov-usage-donut", children: /* @__PURE__ */ e(
            va,
            {
              size: u.size,
              thickness: u.thickness,
              interactive: !0,
              formatValue: Ie,
              ariaLabel: "会话概况环形图，点击色块查看占比",
              segments: [
                { value: t.sessionsActive, color: "var(--mk-brand-700)", label: "活跃" },
                { value: t.sessionsGroup, color: "var(--mk-brand-500)", label: "群聊" },
                { value: t.sessionsPrivate, color: "var(--mk-brand-300)", label: "私聊" },
                { value: t.totalMessages, color: "var(--mk-info)", label: "消息" }
              ],
              centerNum: String(t.sessionsTotal)
            }
          ) })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ o("article", { className: "glass-card ov-card", children: [
      /* @__PURE__ */ e("div", { className: "mk-panel-head", children: /* @__PURE__ */ e("h3", { className: "ov-card__title", children: t.balanceIsRate ? "限速用量" : "账户余额" }) }),
      /* @__PURE__ */ e("div", { className: "mk-panel-body ov-card__chart", children: t.balancePct != null ? /* @__PURE__ */ e(
        _a,
        {
          value: t.balancePct,
          tone: t.balanceTone === "ok" ? "var(--mk-brand-600)" : "var(--mk-warn)",
          centerNum: t.balanceLabel,
          centerSub: t.balanceAvailable ? "可用" : ""
        }
      ) : /* @__PURE__ */ e("div", { className: `ov-bignum ov-bignum--${t.balanceTone}`, children: t.balanceLabel }) })
    ] }),
    /* @__PURE__ */ o("article", { className: "glass-card ov-card", children: [
      /* @__PURE__ */ e("div", { className: "mk-panel-head", children: /* @__PURE__ */ e("h3", { className: "ov-card__title", children: "缓存命中" }) }),
      /* @__PURE__ */ e("div", { className: "mk-panel-body ov-card__chart", children: t.cacheHitRate != null ? /* @__PURE__ */ e(_a, { value: t.cacheHitRate, tone: "var(--mk-info)", centerNum: `${Math.round(t.cacheHitRate)}%`, centerSub: "命中率" }) : /* @__PURE__ */ e("div", { className: "ov-bignum ov-bignum--muted", children: "—" }) })
    ] }),
    /* @__PURE__ */ o("article", { className: "glass-card ov-card ov-card--span2", children: [
      /* @__PURE__ */ e("div", { className: "mk-panel-head", children: /* @__PURE__ */ o("h3", { className: "ov-card__title", children: [
        "开启覆盖（",
        d,
        "）"
      ] }) }),
      /* @__PURE__ */ o("div", { className: "mk-panel-body", children: [
        /* @__PURE__ */ e(Ye, { data: m, barColor: "var(--mk-brand-600)", format: (r) => String(r) }),
        /* @__PURE__ */ e("div", { className: "ov-caps", children: /* @__PURE__ */ e(Ye, { data: c, format: (r) => String(r) }) })
      ] })
    ] }),
    /* @__PURE__ */ o("article", { className: "glass-card ov-card ov-card--full", children: [
      /* @__PURE__ */ e("div", { className: "mk-panel-head", children: /* @__PURE__ */ e("h3", { className: "ov-card__title", children: "消息量 Top 5" }) }),
      /* @__PURE__ */ e("div", { className: "mk-panel-body", children: t.topSessions.length ? /* @__PURE__ */ e(Ye, { data: t.topSessions, format: Ie }) : /* @__PURE__ */ e("div", { className: "mk-state", children: "暂无会话" }) })
    ] }),
    /* @__PURE__ */ e("article", { className: "glass-card ov-card ov-card--full ov-card--kpi-row", children: /* @__PURE__ */ e("div", { className: "mk-panel-body", children: /* @__PURE__ */ o("div", { className: "ov-kpi ov-kpi--footer", children: [
      /* @__PURE__ */ e(Ae, { num: Ie(t.totalRequests), label: "累计请求" }),
      /* @__PURE__ */ e(Ae, { num: He(t.totalTokens), label: "累计 Token" }),
      /* @__PURE__ */ e(Ae, { num: Ie(t.todayRequests), label: "今日请求" }),
      /* @__PURE__ */ e(Ae, { num: vt(t.estimatedCost), label: "预计花费" })
    ] }) }) })
  ] }) });
}
const yt = 3e3;
function Ma({
  src: a,
  name: i,
  out: t
}) {
  const [n, l] = v(!1);
  return !a || n ? /* @__PURE__ */ e("div", { className: `im-avatar${t ? " out" : ""}`, "aria-hidden": !0, children: ct(i) }) : /* @__PURE__ */ e(
    "img",
    {
      className: `im-avatar-img${t ? " out" : ""}`,
      src: a,
      alt: "",
      onError: () => l(!0)
    }
  );
}
function wt({
  api: a,
  toast: i,
  confirm: t
}) {
  const n = kt({ api: a, toast: i, confirm: t }), l = j(null), u = j(null), d = j(null), m = j(!1), c = n.bubbles;
  q(() => {
    n.active && u.current?.scrollIntoView({ block: "end" });
  }, [n.active, c.length, n.loadingChat]);
  const r = E(() => {
    d.current && (clearTimeout(d.current), d.current = null);
  }, []), x = E(
    (k) => {
      r(), d.current = setTimeout(() => {
        d.current = null, m.current = !0, n.deleteSession(k);
      }, yt);
    },
    [r, n]
  );
  if (q(() => () => r(), [r]), n.active) {
    const k = n.active, h = Ce(k), y = he(k) ? "private" : "group", s = String(n.detail?.bot_card || n.detail?.bot_nickname || "机器人"), p = n.botUserId ? Be(n.botUserId) : "";
    return /* @__PURE__ */ e("section", { className: "mkai-page-sessions is-chat", children: /* @__PURE__ */ e("div", { className: "im-shell im-shell-page", children: /* @__PURE__ */ o("div", { className: "im-pane im-pane-full", children: [
      /* @__PURE__ */ o("div", { className: "im-pane-head", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "im-back", onClick: n.backToList, "aria-label": "返回列表", children: "← 返回" }),
        /* @__PURE__ */ o("div", { style: { minWidth: 0, flex: 1 }, children: [
          /* @__PURE__ */ o("div", { className: "im-pane-title", children: [
            h,
            k.messageCount != null ? ` (${k.messageCount})` : ""
          ] }),
          /* @__PURE__ */ e("div", { className: "im-pane-sub", children: k.chatId })
        ] }),
        /* @__PURE__ */ e("span", { className: `im-pane-type ${y}`, children: y === "group" ? "群聊" : "好友" })
      ] }),
      /* @__PURE__ */ o("div", { className: "im-messages", ref: l, children: [
        n.loadingChat && !c.length ? /* @__PURE__ */ e("div", { className: "im-empty", children: "加载中…" }) : null,
        !n.loadingChat && !c.length ? /* @__PURE__ */ e("div", { className: "im-empty", children: "该会话暂无消息" }) : null,
        c.map((g) => {
          if (g.side === "sys")
            return /* @__PURE__ */ e("div", { className: "im-sys", children: g.text }, g.id);
          const _ = g.side === "out", C = _ ? p : g.qq ? Be(g.qq) : "";
          return /* @__PURE__ */ o("div", { className: `im-msg${_ ? " out" : ""}`, children: [
            /* @__PURE__ */ e(Ma, { src: C, name: _ ? s : g.name, out: _ }),
            /* @__PURE__ */ o("div", { className: "im-msg-body", children: [
              /* @__PURE__ */ o("div", { className: "im-msg-head", children: [
                /* @__PURE__ */ e("span", { className: "im-msg-name", children: g.name }),
                g.groupTitle ? /* @__PURE__ */ e("span", { className: "im-msg-title", title: "群头衔", children: g.groupTitle }) : null,
                g.groupRole ? /* @__PURE__ */ e("span", { className: "im-msg-role", children: mt(g.groupRole) }) : null,
                g.time ? /* @__PURE__ */ e("span", { className: "im-msg-time", children: g.time }) : null
              ] }),
              g.replyTo || g.atTargets ? /* @__PURE__ */ o("div", { className: "im-msg-meta", children: [
                g.replyTo ? /* @__PURE__ */ e("span", { className: "im-msg-meta__chip im-msg-meta__chip--reply", children: g.replyTo }) : null,
                g.atTargets ? /* @__PURE__ */ e("span", { className: "im-msg-meta__chip im-msg-meta__chip--at", children: g.atTargets }) : null
              ] }) : null,
              /* @__PURE__ */ o(
                "div",
                {
                  className: `im-bubble${g.kind === "react" || g.kind === "sticker" ? " im-bubble--meta" : ""}${g.kind === "voice" ? " im-bubble--voice" : ""}`,
                  children: [
                    /* @__PURE__ */ e("div", { className: "im-bubble-text", children: g.text }),
                    g.imageNotes?.length ? /* @__PURE__ */ e("div", { className: "im-bubble-eyes", title: "识图解析", children: g.imageNotes.map((P, $) => /* @__PURE__ */ e("div", { className: "im-bubble-eyes__line", children: P }, `${g.id}-eye-${$}`)) }) : null
                  ]
                }
              )
            ] })
          ] }, g.id);
        }),
        /* @__PURE__ */ e("div", { ref: u, "aria-hidden": !0, className: "im-scroll-anchor" })
      ] })
    ] }) }) });
  }
  return /* @__PURE__ */ e("section", { className: "mkai-page-sessions", children: /* @__PURE__ */ e("div", { className: "im-shell im-shell-page stagger-item stagger-2", children: /* @__PURE__ */ o("div", { className: "im-list-col im-list-full", children: [
    /* @__PURE__ */ o("div", { className: "im-list-head", children: [
      /* @__PURE__ */ e(
        "input",
        {
          type: "search",
          placeholder: "搜索会话…",
          value: n.q,
          onChange: (k) => n.setQ(k.target.value)
        }
      ),
      /* @__PURE__ */ o("label", { className: "im-list-toggle", style: { display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", fontSize: 12 }, children: [
        /* @__PURE__ */ e(
          "input",
          {
            type: "checkbox",
            checked: n.showEmpty,
            onChange: (k) => n.setShowEmpty(k.target.checked)
          }
        ),
        "显示空会话"
      ] }),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "im-back",
          disabled: n.pruning,
          onClick: () => void n.pruneEmpty(),
          style: { whiteSpace: "nowrap" },
          children: n.pruning ? "清理中…" : "清理空会话"
        }
      )
    ] }),
    /* @__PURE__ */ o("div", { className: "im-sessions", children: [
      n.loading ? /* @__PURE__ */ e("div", { className: "im-empty", children: "加载中…" }) : null,
      !n.loading && !n.filtered.length ? /* @__PURE__ */ e("div", { className: "im-empty", children: "暂无会话" }) : null,
      n.filtered.map((k) => {
        const h = Ce(k), y = he(k) ? "private" : "group", s = pt(k), p = s.id ? s.kind === "group" ? Da(s.id) : Be(s.id) : "", g = !!k.active;
        return /* @__PURE__ */ o(
          "div",
          {
            className: `im-session ${g ? "is-active" : "is-stale"}`,
            onClick: () => {
              if (m.current) {
                m.current = !1;
                return;
              }
              n.openChat(k);
            },
            onPointerDown: () => x(k),
            onPointerUp: r,
            onPointerLeave: r,
            onPointerCancel: r,
            role: "button",
            tabIndex: 0,
            onKeyDown: (_) => {
              (_.key === "Enter" || _.key === " ") && (_.preventDefault(), n.openChat(k));
            },
            children: [
              /* @__PURE__ */ e(Ma, { src: p, name: h }),
              /* @__PURE__ */ o("div", { className: "im-session-body", children: [
                /* @__PURE__ */ o("div", { className: "im-session-top", children: [
                  /* @__PURE__ */ e("span", { className: "im-session-title", children: h }),
                  /* @__PURE__ */ e("span", { className: `im-type ${y}`, children: y === "group" ? "群聊" : "好友" })
                ] }),
                /* @__PURE__ */ e("div", { className: "im-session-bottom", children: /* @__PURE__ */ o("span", { className: "im-session-preview", children: [
                  k.chatId,
                  k.messageCount != null ? ` · ${k.messageCount} 条` : "",
                  k.config_fingerprint ? ` · fp ${String(k.config_fingerprint).slice(0, 8)}` : ""
                ] }) })
              ] })
            ]
          },
          na(k)
        );
      })
    ] })
  ] }) }) });
}
function Nt({
  api: a,
  toast: i
}) {
  const [t, n] = v("group"), [l, u] = v(!0), [d, m] = v([]), [c, r] = v({}), [x, k] = v(""), [h, y] = v(!1), [s, p] = v(!1), [g, _] = v(""), [C, P] = v(!1), [$, W] = v({
    type: "group",
    id: "",
    name: "",
    rounds: 0,
    image_recognize: !1,
    file_recognize: !1,
    sticker_output: !1,
    web_search: !1,
    at_only: !1,
    at_only_record: !0,
    fake_think: !1,
    allow_voice: !1,
    system_prompt: ""
  }), K = j(i);
  K.current = i;
  const A = Z(() => {
    const w = x.trim().toLowerCase();
    return w ? d.filter((M) => M.name.toLowerCase().includes(w) || M.id.includes(w)) : d;
  }, [d, x]), U = E(async () => {
    u(!0);
    try {
      let w = [];
      t === "group" ? w = ((await a.get("/groups")).data?.groups || []).map((Q) => ({
        id: String(Q.group_id || ""),
        name: String(Q.group_name || "未知群聊")
      })).filter((Q) => Q.id) : w = ((await a.get("/friends")).data?.friends || []).map((Q) => ({
        id: String(Q.user_id || ""),
        name: String(Q.nickname || "未知好友")
      })).filter((Q) => Q.id), m(w);
      const M = w.map((O) => O.id).join(","), I = await a.get(
        "/smart-chat/switches",
        { type: t, ids: M || void 0 }
      );
      r(I.data?.map || {}), I.data?.global_system_prompt != null && _(String(I.data.global_system_prompt || "")), I.data?.sticker_gallery_ready != null && p(!!I.data.sticker_gallery_ready);
    } catch (w) {
      K.current(w instanceof Error ? w.message : String(w)), m([]);
    } finally {
      u(!1);
    }
  }, [a, t]);
  q(() => {
    U();
  }, [U]);
  const F = E(async () => {
    try {
      const w = await a.get("/smart-chat/sticker/galleries");
      p(!!w.data?.ready);
    } catch {
    }
  }, [a]), G = E(
    async (w, M) => {
      const I = c[w] || we;
      r((O) => ({ ...O, [w]: { ...I, enabled: M, ai_only: !1 } }));
      try {
        const O = await a.post("/smart-chat/switches/set", {
          type: t,
          id: w,
          enabled: M,
          ai_only: !1,
          rounds: I.rounds,
          image_recognize: I.image_recognize,
          file_recognize: I.file_recognize,
          sticker_output: I.sticker_output,
          web_search: I.web_search
        });
        if (O.code !== 0) throw new Error(O.message || "保存失败");
        i(M ? "已开启" : "已关闭", "ok");
      } catch (O) {
        throw r((Q) => ({ ...Q, [w]: I })), i(O instanceof Error ? O.message : String(O), "err"), O;
      }
    },
    [a, c, t, i]
  ), H = E(
    async (w, M) => {
      F();
      const I = c[w] || we, O = String(I.system_prompt || "").trim();
      W({
        type: t,
        id: w,
        name: M,
        rounds: Oe(I.rounds),
        image_recognize: !!I.image_recognize,
        file_recognize: !!I.file_recognize,
        sticker_output: !!I.sticker_output,
        web_search: !!I.web_search,
        at_only: !!I.at_only,
        at_only_record: I.at_only_record !== !1,
        fake_think: !!I.fake_think,
        allow_voice: !!I.allow_voice,
        system_prompt: O || g
      }), P(!0);
    },
    [g, F, c, t]
  ), L = E(async () => {
    try {
      const w = await a.post("/smart-chat/switches/set", {
        type: $.type,
        id: $.id,
        enabled: !!(c[$.id] || we).enabled,
        ai_only: !1,
        rounds: Oe($.rounds),
        image_recognize: $.image_recognize,
        file_recognize: $.file_recognize,
        sticker_output: $.sticker_output,
        web_search: $.web_search,
        at_only: $.at_only,
        at_only_record: $.at_only_record,
        fake_think: $.fake_think,
        allow_voice: $.allow_voice,
        system_prompt: $.system_prompt
      });
      if (w.code !== 0) throw new Error(w.message || "保存失败");
      w.data?.global_system_prompt != null && _(String(w.data.global_system_prompt || "")), r((M) => ({
        ...M,
        [$.id]: {
          ...M[$.id] || we,
          ai_only: !1,
          rounds: Oe($.rounds),
          image_recognize: $.image_recognize,
          file_recognize: $.file_recognize,
          sticker_output: $.sticker_output,
          web_search: $.web_search,
          at_only: $.at_only,
          at_only_record: $.at_only_record,
          fake_think: $.fake_think,
          allow_voice: $.allow_voice,
          system_prompt: String(w.data?.system_prompt ?? "").trim()
        }
      })), P(!1), w.data?.persona_fingerprint_changed ? i("已保存（人设变更，会话命名空间已切换）", "ok") : i("已保存", "ok");
    } catch (w) {
      i(w instanceof Error ? w.message : String(w), "err");
    }
  }, [a, $, c, i]);
  return {
    tab: t,
    setTab: n,
    loading: l,
    list: d,
    switchMap: c,
    search: x,
    setSearch: k,
    searchOpen: h,
    setSearchOpen: y,
    stickerGalleryReady: s,
    globalSystemPrompt: g,
    modalOpen: C,
    setModalOpen: P,
    draft: $,
    setDraft: W,
    filtered: A,
    loadPage: U,
    refreshStickerReady: F,
    toggleEnabled: G,
    openModal: H,
    saveModal: L
  };
}
function ce({
  on: a,
  label: i,
  disabled: t,
  onToggle: n
}) {
  return /* @__PURE__ */ o("div", { className: "switch-row__cap", children: [
    /* @__PURE__ */ e(
      "button",
      {
        type: "button",
        className: `sc-kb-cap${a ? " is-on" : ""}`,
        role: "switch",
        "aria-checked": a ? "true" : "false",
        disabled: t,
        onClick: n,
        style: t ? { opacity: 0.45 } : void 0,
        children: /* @__PURE__ */ e("span", { className: "sc-kb-cap__knob" })
      }
    ),
    /* @__PURE__ */ e("span", { className: "sc-kb-cap__label", children: i })
  ] });
}
function Ct({ src: a, fallback: i }) {
  const [t, n] = v(!1);
  return t ? /* @__PURE__ */ e("span", { children: i }) : /* @__PURE__ */ e(
    "img",
    {
      className: "sw-card__avatar-img",
      src: a,
      alt: "",
      onError: () => n(!0)
    }
  );
}
function St({
  api: a,
  toast: i
}) {
  const t = Nt({ api: a, toast: i }), n = j(null), l = j(!1), u = j(null), d = t.tab === "group" ? 0 : 1, m = je(d, 2, t.tab), c = () => {
    n.current != null && (window.clearTimeout(n.current), n.current = null);
  }, r = (k) => {
    l.current = !1, c(), n.current = window.setTimeout(() => {
      l.current = !0, t.setTab(k), t.setSearch(""), t.setSearchOpen(!0), i("临时搜索已打开（切换界面后清空）", "info"), window.setTimeout(() => u.current?.focus(), 50);
    }, 3e3);
  }, x = (k) => {
    if (l.current) {
      l.current = !1;
      return;
    }
    t.setTab(k), t.setSearch(""), t.setSearchOpen(!1);
  };
  return q(() => () => c(), []), /* @__PURE__ */ o("section", { className: "mkai-page-switch", children: [
    /* @__PURE__ */ e("div", { className: "sw-tabbar stagger-item stagger-2", children: /* @__PURE__ */ o("div", { className: "seg seg--center", ref: m.navRef, children: [
      /* @__PURE__ */ e(
        "div",
        {
          className: `nav-liquid${m.box.ready ? " is-ready" : ""}`,
          style: {
            transform: `translate3d(${m.box.left}px, ${m.box.top}px, 0)`,
            width: m.box.width,
            height: m.box.height
          },
          "aria-hidden": !0
        }
      ),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          ref: (k) => m.setItemRef(0, k),
          className: `seg__btn${t.tab === "group" ? " is-active" : ""}`,
          title: "长按 3 秒打开临时搜索",
          onClick: () => x("group"),
          onPointerDown: () => r("group"),
          onPointerUp: c,
          onPointerLeave: c,
          onPointerCancel: c,
          children: "群聊"
        }
      ),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          ref: (k) => m.setItemRef(1, k),
          className: `seg__btn${t.tab === "friend" ? " is-active" : ""}`,
          title: "长按 3 秒打开临时搜索",
          onClick: () => x("friend"),
          onPointerDown: () => r("friend"),
          onPointerUp: c,
          onPointerLeave: c,
          onPointerCancel: c,
          children: "好友"
        }
      )
    ] }) }),
    t.searchOpen ? /* @__PURE__ */ o("div", { className: "mk-search-field stagger-item stagger-3", children: [
      /* @__PURE__ */ e("span", { className: "mk-search-field__icon", "aria-hidden": "true", children: /* @__PURE__ */ o("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [
        /* @__PURE__ */ e("circle", { cx: "11", cy: "11", r: "8" }),
        /* @__PURE__ */ e("path", { d: "m21 21-4.3-4.3" })
      ] }) }),
      /* @__PURE__ */ e(
        "input",
        {
          ref: u,
          type: "search",
          className: "mk-search-field__input",
          placeholder: t.tab === "group" ? "临时搜索群名或群号…" : "临时搜索好友昵称或 QQ…",
          value: t.search,
          onChange: (k) => t.setSearch(k.target.value),
          autoComplete: "off"
        }
      ),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "mk-search-field__clear",
          "aria-label": "关闭搜索",
          onClick: () => {
            t.setSearch(""), t.setSearchOpen(!1);
          },
          children: /* @__PURE__ */ e("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", children: /* @__PURE__ */ e("path", { d: "M18 6 6 18M6 6l12 12" }) })
        }
      )
    ] }) : null,
    /* @__PURE__ */ o("div", { className: "stagger-item stagger-4", children: [
      t.loading ? /* @__PURE__ */ e("div", { className: "sw-skeleton-grid", children: Array.from({ length: 6 }).map((k, h) => /* @__PURE__ */ e("div", { className: "sw-skeleton" }, h)) }) : null,
      !t.loading && !t.filtered.length ? /* @__PURE__ */ e("div", { className: "mk-state", children: t.search.trim() ? "无匹配结果" : "暂无数据" }) : null,
      !t.loading && t.filtered.length ? /* @__PURE__ */ e("div", { className: "sw-grid", children: t.filtered.map((k, h) => {
        const y = t.switchMap[k.id] || we, s = !!y.enabled, p = t.tab === "group", g = Pi(y);
        return /* @__PURE__ */ o(
          "article",
          {
            className: `sw-card${s ? " is-on" : ""} ${p ? "is-group" : "is-friend"} stagger-item`,
            style: { animationDelay: `${0.05 + Math.min(h, 12) * 0.04}s` },
            children: [
              /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "sw-card__avatar",
                  title: "更多设置",
                  onClick: () => void t.openModal(k.id, k.name),
                  children: /* @__PURE__ */ e(
                    Ct,
                    {
                      src: p ? Da(k.id) : Be(k.id),
                      fallback: (k.name || "?").charAt(0)
                    }
                  )
                }
              ),
              /* @__PURE__ */ o("div", { className: "sw-card__body", children: [
                /* @__PURE__ */ e("div", { className: "sw-card__name", title: k.name, children: k.name }),
                /* @__PURE__ */ o("div", { className: "sw-card__meta", children: [
                  p ? "群" : "QQ",
                  " ",
                  k.id,
                  g.length ? ` · ${g.join(" · ")}` : ""
                ] })
              ] }),
              /* @__PURE__ */ o("label", { className: "toggle-switch sw-card__toggle", "aria-label": "开关", children: [
                /* @__PURE__ */ e(
                  "input",
                  {
                    type: "checkbox",
                    checked: s,
                    onChange: (_) => {
                      const C = _.target.checked;
                      t.toggleEnabled(k.id, C).catch(() => {
                        _.target.checked = !C;
                      });
                    }
                  }
                ),
                /* @__PURE__ */ e("span", { className: "toggle-slider" })
              ] })
            ]
          },
          k.id
        );
      }) }) : null
    ] }),
    /* @__PURE__ */ e(Ba, { open: t.modalOpen, onClose: () => t.setModalOpen(!1), children: /* @__PURE__ */ o("div", { className: "mk-modal mk-modal--enter", role: "dialog", "aria-modal": "true", onClick: (k) => k.stopPropagation(), children: [
      /* @__PURE__ */ e("h3", { className: "mk-modal__title", children: "更多设置" }),
      /* @__PURE__ */ o("p", { className: "mk-hint", style: { margin: "0 0 16px" }, children: [
        t.draft.name,
        " · ",
        t.draft.id
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "识别图片" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "异步识图；参数在「能力扩展」" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.image_recognize,
            label: t.draft.image_recognize ? "开" : "关",
            onToggle: () => t.setDraft((k) => ({ ...k, image_recognize: !k.image_recognize }))
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "识别文件" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: t.tab === "group" ? "群文件存到插件目录并读进上下文，支持 txt/js/mjs/ts/go/sh/bat/log，单个 ≤500KB，只读不运行" : "仅群聊可用，私聊没有群文件" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.file_recognize,
            label: t.draft.file_recognize ? "开" : "关",
            disabled: t.tab !== "group",
            onToggle: () => {
              if (t.tab !== "group") {
                i("识别文件仅群聊可用", "warn");
                return;
              }
              t.setDraft((k) => ({ ...k, file_recognize: !k.file_recognize }));
            }
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "联网搜索" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "允许调用 web_search" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.web_search,
            label: t.draft.web_search ? "开" : "关",
            onToggle: () => t.setDraft((k) => ({ ...k, web_search: !k.web_search }))
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "表情输出" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: t.stickerGalleryReady ? "可发送已装图库表情" : "请先在「能力扩展」安装图库" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.sticker_output,
            label: t.draft.sticker_output ? "开" : "关",
            disabled: !t.stickerGalleryReady && !t.draft.sticker_output,
            onToggle: () => {
              if (!t.stickerGalleryReady && !t.draft.sticker_output) {
                i("请先安装表情图库", "warn");
                return;
              }
              t.setDraft((k) => ({ ...k, sticker_output: !k.sticker_output }));
            }
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "是否仅@时触发" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "开启后防抖/最大合并失效，仅被 @ 时才回应" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.at_only,
            label: t.draft.at_only ? "开" : "关",
            onToggle: () => t.setDraft((k) => ({ ...k, at_only: !k.at_only }))
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "仅艾特模式时是否记录其他消息" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: t.draft.at_only ? "关闭则只记录被 @ 的那条消息" : "需先开启「仅@时触发」" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.at_only_record,
            label: t.draft.at_only_record ? "开" : "关",
            disabled: !t.draft.at_only,
            onToggle: () => {
              if (!t.draft.at_only) {
                i("请先开启「仅@时触发」", "warn");
                return;
              }
              t.setDraft((k) => ({ ...k, at_only_record: !k.at_only_record }));
            }
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "伪装思考" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "开启后允许模型先写一段思考草稿，不发到群、仅后台留存复盘；模型自带思考时自动跳过" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.fake_think,
            label: t.draft.fake_think ? "开" : "关",
            onToggle: () => t.setDraft((k) => ({ ...k, fake_think: !k.fake_think }))
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "switch-row", children: [
        /* @__PURE__ */ o("div", { children: [
          /* @__PURE__ */ e("div", { className: "switch-row__title", children: "允许以语音形式输出" }),
          /* @__PURE__ */ e("div", { className: "switch-row__desc", children: "开启后，合格短句（净化后≤150字、无@/引用/特殊符号）可转语音发送；需先在「语音输出」页配好角色，单次回复最多两条语音，超长或失败自动回退文本" })
        ] }),
        /* @__PURE__ */ e(
          ce,
          {
            on: t.draft.allow_voice,
            label: t.draft.allow_voice ? "开" : "关",
            onToggle: () => t.setDraft((k) => ({ ...k, allow_voice: !k.allow_voice }))
          }
        )
      ] }),
      /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
        /* @__PURE__ */ e("label", { className: "mk-label", children: "历史轮次" }),
        /* @__PURE__ */ e(
          "input",
          {
            type: "number",
            className: "mk-input",
            min: 0,
            max: 999,
            value: t.draft.rounds,
            onChange: (k) => t.setDraft((h) => ({ ...h, rounds: Number(k.target.value) || 0 }))
          }
        ),
        /* @__PURE__ */ e("p", { className: "mk-hint", children: "0 = 全部历史；1～999 = 最近 N 轮" })
      ] }),
      /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
        /* @__PURE__ */ o("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", style: { margin: 0 }, children: "独立人设" }),
          /* @__PURE__ */ e(
            "button",
            {
              type: "button",
              className: "mk-btn mk-btn--ghost mk-btn--sm",
              onClick: () => t.setDraft((k) => ({ ...k, system_prompt: t.globalSystemPrompt })),
              children: "重置"
            }
          )
        ] }),
        /* @__PURE__ */ e(
          "textarea",
          {
            className: "mk-input mk-input--prompt",
            rows: 5,
            maxLength: 1200,
            value: t.draft.system_prompt,
            onChange: (k) => {
              const h = k.target.value.slice(0, 1200);
              t.setDraft((y) => ({ ...y, system_prompt: h }));
            },
            placeholder: "默认跟随全局人格；可在此个性化",
            style: { marginTop: 8, resize: "vertical", minHeight: 100 }
          }
        ),
        /* @__PURE__ */ o("p", { className: "mk-hint", style: { margin: "4px 0 0", textAlign: "right" }, children: [
          (t.draft.system_prompt || "").length,
          "/1200"
        ] })
      ] }),
      /* @__PURE__ */ o("div", { className: "mk-btn-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", onClick: () => void t.saveModal(), children: "保存" }),
        /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost", onClick: () => t.setModalOpen(!1), children: "取消" })
      ] })
    ] }) })
  ] });
}
const $t = "https://api.pearapi.ai/zh/auth?ref=V9SSQ7AT", qe = "病娇少女";
function Mt({ api: a, toast: i }) {
  const [t, n] = v(!0), [l, u] = v(!1), [d, m] = v("pearapi"), [c, r] = v(!1), [x, k] = v(""), [h, y] = v(""), [s, p] = v(!1), [g, _] = v(""), [C, P] = v("ogg"), [$, W] = v([]), [K, A] = v(!1), [U, F] = v(!1), [G, H] = v(""), [L, w] = v(""), [M, I] = v(""), [O, Q] = v([]), [ae, te] = v(!1), [Y, X] = v(!1), [pe, ie] = v(""), [J, S] = v(150), V = j(null), ve = j(null), le = E(async () => {
    n(!0);
    try {
      const N = await a.get("/smart-chat/config");
      if (N.code !== 0) throw new Error(N.message || "加载失败");
      const z = N.data && N.data.voice || {};
      m(z.engine === "qqai" ? "qqai" : "pearapi"), r(!!z.api_key_set), k(String(z.api_key || "")), y(""), p(!1), _(String(z.dub || "")), P(z.format === "mp3" ? "mp3" : "ogg"), w(String(z.qq_character || "")), I(String(z.qq_ref_group || "")), S(Number(z.max_chars) || 150);
    } catch (N) {
      i(N instanceof Error ? N.message : String(N), "err");
    } finally {
      n(!1);
    }
  }, [a, i]);
  q(() => {
    le();
  }, [le]), q(() => {
    if (!K && !ae) return;
    const N = (z) => {
      V.current && !V.current.contains(z.target) && A(!1), ve.current && !ve.current.contains(z.target) && te(!1);
    };
    return document.addEventListener("mousedown", N), () => document.removeEventListener("mousedown", N);
  }, [K, ae]);
  const De = E(async () => {
    F(!0);
    try {
      const N = await a.get("/smart-chat/voice-roles"), z = N.data || {};
      if (N.code !== 0) throw new Error(N.message || "拉取失败");
      const D = Array.isArray(z.roles) ? z.roles : [];
      W(D), A(!0), D.length || i(z.error || "未获取到角色，可手动填写角色名", "err");
    } catch (N) {
      i(N instanceof Error ? N.message : String(N), "err");
    } finally {
      F(!1);
    }
  }, [a, i]), $e = E(async () => {
    const N = M.trim();
    if (!N) {
      i("先填一个参考群号（用于拉取 QQ AI 角色）", "err");
      return;
    }
    X(!0);
    try {
      const z = await a.get(
        `/smart-chat/voice-characters?group_id=${encodeURIComponent(N)}`
      ), D = z.data || {};
      if (z.code !== 0) throw new Error(z.message || "拉取失败");
      const ee = Array.isArray(D.characters) ? D.characters : [];
      Q(ee), te(!0), ee.length || i(D.error || "未获取到 QQ AI 角色（该群可能未开通或机器人不在群）", "err");
    } catch (z) {
      i(z instanceof Error ? z.message : String(z), "err");
    } finally {
      X(!1);
    }
  }, [a, i, M]), Me = Z(() => {
    const N = G.trim().toLowerCase();
    return N ? $.filter((z) => z.toLowerCase().includes(N)) : $;
  }, [$, G]), ue = Z(() => {
    const N = pe.trim().toLowerCase();
    return N ? O.filter((z) => z.name.toLowerCase().includes(N) || z.id.toLowerCase().includes(N) || z.group.toLowerCase().includes(N)) : O;
  }, [O, pe]), Ue = E(async () => {
    u(!0);
    try {
      const N = {
        engine: d,
        dub: g.trim(),
        format: C,
        qq_character: L.trim(),
        qq_ref_group: M.trim(),
        max_chars: J
      };
      s && (N.api_key = h.trim());
      const z = await a.post("/smart-chat/voice-config", N);
      if (z.code !== 0) throw new Error(z.message || "保存失败");
      const D = z.data && z.data.voice || {};
      m(D.engine === "qqai" ? "qqai" : "pearapi"), r(!!D.api_key_set), k(String(D.api_key || "")), y(""), p(!1), _(String(D.dub || "")), P(D.format === "mp3" ? "mp3" : "ogg"), w(String(D.qq_character || "")), I(String(D.qq_ref_group || "")), S(Number(D.max_chars) || 150), i("语音配置已保存", "ok");
    } catch (N) {
      i(N instanceof Error ? N.message : String(N), "err");
    } finally {
      u(!1);
    }
  }, [a, i, d, g, C, L, M, J, s, h]);
  return /* @__PURE__ */ e("section", { className: "mkai-page-voice", children: /* @__PURE__ */ o("div", { className: "panel stagger-item stagger-2", children: [
    /* @__PURE__ */ e("h2", { className: "panel-title", children: "语音输出" }),
    t ? /* @__PURE__ */ e("p", { className: "mk-hint", children: "加载中…" }) : /* @__PURE__ */ o(ne, { children: [
      /* @__PURE__ */ o("div", { className: "mk-form-group", children: [
        /* @__PURE__ */ e("label", { className: "mk-label", children: "语音引擎" }),
        /* @__PURE__ */ o("div", { className: "mk-seg mk-seg--fill", role: "group", "aria-label": "语音引擎", children: [
          /* @__PURE__ */ e(
            "button",
            {
              type: "button",
              className: `mk-seg__btn${d === "pearapi" ? " mk-seg__btn--active" : ""}`,
              "aria-pressed": d === "pearapi",
              onClick: () => m("pearapi"),
              children: "第三方配音"
            }
          ),
          /* @__PURE__ */ e(
            "button",
            {
              type: "button",
              className: `mk-seg__btn${d === "qqai" ? " mk-seg__btn--active" : ""}`,
              "aria-pressed": d === "qqai",
              onClick: () => m("qqai"),
              children: "QQAI配音"
            }
          )
        ] })
      ] }),
      d === "pearapi" ? /* @__PURE__ */ o(ne, { children: [
        /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "配音密钥（可选）" }),
          /* @__PURE__ */ e(
            "input",
            {
              type: "text",
              className: "mk-input",
              placeholder: c ? `已设置：${x}（留空不改动）` : "留空使用内置体验额度",
              value: h,
              onChange: (N) => {
                y(N.target.value), p(!0);
              }
            }
          ),
          /* @__PURE__ */ o("p", { className: "mk-hint", children: [
            "默认使用插件内置的体验额度，无需填写。若要用自己的账号，填入密钥后优先使用；",
            c ? "清空并保存可改回内置额度。" : ""
          ] }),
          /* @__PURE__ */ o(
            "a",
            {
              className: "mk-link-out",
              href: $t,
              target: "_blank",
              rel: "noopener noreferrer",
              children: [
                "前往官网获取密钥",
                /* @__PURE__ */ e("span", { className: "mk-link-out__arrow", "aria-hidden": !0, children: "↗" })
              ]
            }
          )
        ] }),
        /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "配音角色" }),
          /* @__PURE__ */ o("div", { className: "mk-model-picker", ref: V, children: [
            /* @__PURE__ */ o("div", { className: "mk-input-with-action", children: [
              /* @__PURE__ */ e(
                "input",
                {
                  type: "text",
                  className: "mk-input",
                  placeholder: `角色名，如「${qe}」；点右侧按钮拉取全部角色`,
                  value: g,
                  onChange: (N) => _(N.target.value)
                }
              ),
              /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "mk-input-with-action__btn",
                  title: "拉取角色列表",
                  disabled: U,
                  onClick: () => void De(),
                  children: U ? "…" : "↻"
                }
              )
            ] }),
            K && $.length > 0 ? /* @__PURE__ */ o("div", { className: "mk-model-list", role: "listbox", "aria-label": "配音角色列表", children: [
              /* @__PURE__ */ o("div", { className: "mk-model-list__head", children: [
                /* @__PURE__ */ o("span", { children: [
                  Me.length,
                  "/",
                  $.length,
                  " 个角色"
                ] }),
                /* @__PURE__ */ e("button", { type: "button", className: "mk-model-list__close", "aria-label": "关闭", onClick: () => A(!1), children: "×" })
              ] }),
              /* @__PURE__ */ e("div", { style: { padding: "6px 8px" }, children: /* @__PURE__ */ e("input", { type: "text", className: "mk-input", placeholder: "搜索角色…", value: G, onChange: (N) => H(N.target.value) }) }),
              /* @__PURE__ */ e("ul", { className: "mk-model-list__items", children: Me.slice(0, 200).map((N) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "mk-model-list__item",
                  role: "option",
                  "aria-selected": g === N,
                  onClick: () => {
                    _(N), A(!1), i(`已选择 ${N}`, "ok");
                  },
                  children: N
                }
              ) }, N)) })
            ] }) : null
          ] }),
          /* @__PURE__ */ o("p", { className: "mk-hint", children: [
            "留空则默认使用「",
            qe,
            "」，保存后生效。"
          ] }),
          g.trim() ? null : /* @__PURE__ */ o(
            "button",
            {
              type: "button",
              className: "mk-btn mk-btn--ghost",
              onClick: () => _(qe),
              children: [
                "填入默认角色「",
                qe,
                "」"
              ]
            }
          )
        ] }),
        /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "音频格式" }),
          /* @__PURE__ */ o("select", { className: "mk-input", value: C, onChange: (N) => P(N.target.value === "mp3" ? "mp3" : "ogg"), children: [
            /* @__PURE__ */ e("option", { value: "ogg", children: "ogg（更贴合 QQ 语音）" }),
            /* @__PURE__ */ e("option", { value: "mp3", children: "mp3" })
          ] })
        ] })
      ] }) : /* @__PURE__ */ o(ne, { children: [
        /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "参考群号（拉取角色用）" }),
          /* @__PURE__ */ e(
            "input",
            {
              type: "text",
              className: "mk-input",
              inputMode: "numeric",
              placeholder: "填一个机器人已在的群号，用来列出可用的 QQ AI 角色",
              value: M,
              onChange: (N) => I(N.target.value.replace(/[^0-9]/g, ""))
            }
          ),
          /* @__PURE__ */ e("p", { className: "mk-hint", children: "QQ AI 角色列表按群拉取；这里只用于列举，实际发送用的是当前对话所在群。" })
        ] }),
        /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
          /* @__PURE__ */ e("label", { className: "mk-label", children: "QQ AI 角色" }),
          /* @__PURE__ */ o("div", { className: "mk-model-picker", ref: ve, children: [
            /* @__PURE__ */ o("div", { className: "mk-input-with-action", children: [
              /* @__PURE__ */ e(
                "input",
                {
                  type: "text",
                  className: "mk-input",
                  placeholder: "角色 id（character）；点右侧按钮按参考群拉取",
                  value: L,
                  onChange: (N) => w(N.target.value)
                }
              ),
              /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "mk-input-with-action__btn",
                  title: "拉取 QQ AI 角色",
                  disabled: Y,
                  onClick: () => void $e(),
                  children: Y ? "…" : "↻"
                }
              )
            ] }),
            ae && O.length > 0 ? /* @__PURE__ */ o("div", { className: "mk-model-list", role: "listbox", "aria-label": "QQ AI 角色列表", children: [
              /* @__PURE__ */ o("div", { className: "mk-model-list__head", children: [
                /* @__PURE__ */ o("span", { children: [
                  ue.length,
                  "/",
                  O.length,
                  " 个角色"
                ] }),
                /* @__PURE__ */ e("button", { type: "button", className: "mk-model-list__close", "aria-label": "关闭", onClick: () => te(!1), children: "×" })
              ] }),
              /* @__PURE__ */ e("div", { style: { padding: "6px 8px" }, children: /* @__PURE__ */ e("input", { type: "text", className: "mk-input", placeholder: "搜索角色…", value: pe, onChange: (N) => ie(N.target.value) }) }),
              /* @__PURE__ */ e("ul", { className: "mk-model-list__items", children: ue.slice(0, 200).map((N) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ o(
                "button",
                {
                  type: "button",
                  className: "mk-model-list__item",
                  role: "option",
                  "aria-selected": L === N.id,
                  onClick: () => {
                    w(N.id), te(!1), i(`已选择 ${N.name}`, "ok");
                  },
                  children: [
                    N.name,
                    /* @__PURE__ */ e("span", { style: { opacity: 0.55, marginLeft: 8, fontSize: 12 }, children: N.group })
                  ]
                }
              ) }, N.id)) })
            ] }) : null
          ] }),
          /* @__PURE__ */ e("p", { className: "mk-hint", children: "未选择角色时，即便开了语音开关也只会按文本发送。私聊不支持 QQ AI 语音，会自动回退文本。" })
        ] })
      ] }),
      /* @__PURE__ */ o("div", { className: "mk-form-group", style: { marginTop: 14 }, children: [
        /* @__PURE__ */ e("label", { className: "mk-label", children: "单条语音最大字符数" }),
        /* @__PURE__ */ e(
          "input",
          {
            type: "number",
            className: "mk-input",
            min: 30,
            max: 150,
            value: J,
            onChange: (N) => S(Number(N.target.value) || 150)
          }
        ),
        /* @__PURE__ */ e("p", { className: "mk-hint", children: "净化后超过该长度的语音气泡改按文本发送；上限 150。" })
      ] }),
      /* @__PURE__ */ o("div", { className: "mk-btn-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--primary", disabled: l, onClick: () => void Ue(), children: l ? "保存中…" : "保存" }),
        /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost", disabled: t, onClick: () => void le(), children: "重新加载" })
      ] })
    ] })
  ] }) });
}
function zt({
  open: a,
  onClose: i,
  nav: t,
  setView: n,
  status: l
}) {
  const [u, d] = v(""), [m, c] = v(0), r = j(null), { host: x } = xe(), k = Z(() => {
    const g = t.map((C) => ({
      id: `nav:${C.id}`,
      label: C.label,
      hint: "前往",
      group: C.group ? `导航 · ${C.group}` : "导航",
      keywords: `${C.label} ${C.short} ${C.id}`,
      run: () => n(C.id)
    })), _ = [
      { id: "act:refresh", label: "刷新状态", hint: "厂商 / 模型 / 余额", group: "操作", keywords: "refresh shuaxin zhuangtai", run: () => void l.refresh() },
      { id: "act:probe", label: "测试模型连通性", hint: "探测 API", group: "操作", keywords: "probe test liantong", run: () => void l.probe() }
    ];
    return [...g, ..._];
  }, [t, n, l]), h = Z(() => {
    const g = u.trim().toLowerCase();
    return g ? k.filter((_) => `${_.label} ${_.keywords ?? ""}`.toLowerCase().includes(g)) : k;
  }, [k, u]);
  q(() => {
    if (!a) return;
    d(""), c(0);
    const g = window.setTimeout(() => r.current?.focus(), 30);
    return () => window.clearTimeout(g);
  }, [a]), q(() => {
    c((g) => Math.min(g, Math.max(0, h.length - 1)));
  }, [h.length]);
  const y = E(
    (g) => {
      const _ = h[g];
      _ && (_.run(), i());
    },
    [h, i]
  ), s = (g) => {
    g.key === "ArrowDown" ? (g.preventDefault(), c((_) => Math.min(_ + 1, h.length - 1))) : g.key === "ArrowUp" ? (g.preventDefault(), c((_) => Math.max(_ - 1, 0))) : g.key === "Enter" ? (g.preventDefault(), y(m)) : g.key === "Escape" && (g.preventDefault(), i());
  };
  if (!a || !x) return null;
  let p = "";
  return ke(
    /* @__PURE__ */ o("div", { className: "mk-cmdk", role: "dialog", "aria-modal": "true", "aria-label": "命令面板", children: [
      /* @__PURE__ */ e("div", { className: "mk-cmdk__scrim", onClick: i }),
      /* @__PURE__ */ o("div", { className: "mk-cmdk__panel", children: [
        /* @__PURE__ */ o("div", { className: "mk-cmdk__search", children: [
          /* @__PURE__ */ e("span", { className: "mk-cmdk__icon", "aria-hidden": !0, children: "⌘" }),
          /* @__PURE__ */ e(
            "input",
            {
              ref: r,
              className: "mk-cmdk__input",
              type: "text",
              placeholder: "搜索视图或操作…",
              value: u,
              onChange: (g) => {
                d(g.target.value), c(0);
              },
              onKeyDown: s,
              role: "combobox",
              "aria-expanded": "true",
              "aria-controls": "mk-cmdk-list",
              "aria-autocomplete": "list"
            }
          ),
          /* @__PURE__ */ e("kbd", { className: "mk-cmdk__kbd", children: "Esc" })
        ] }),
        /* @__PURE__ */ e("ul", { className: "mk-cmdk__list", id: "mk-cmdk-list", role: "listbox", children: h.length === 0 ? /* @__PURE__ */ e("li", { className: "mk-cmdk__empty", children: "无匹配命令" }) : h.map((g, _) => {
          const C = g.group !== p;
          return p = g.group, /* @__PURE__ */ o("li", { role: "presentation", children: [
            C ? /* @__PURE__ */ e("div", { className: "mk-cmdk__group", children: g.group }) : null,
            /* @__PURE__ */ o(
              "button",
              {
                type: "button",
                role: "option",
                "aria-selected": _ === m,
                className: `mk-cmdk__item${_ === m ? " is-active" : ""}`,
                onMouseEnter: () => c(_),
                onClick: () => y(_),
                children: [
                  /* @__PURE__ */ e("span", { className: "mk-cmdk__item-label", children: g.label }),
                  g.hint ? /* @__PURE__ */ e("span", { className: "mk-cmdk__item-hint", children: g.hint }) : null
                ]
              }
            )
          ] }, g.id);
        }) })
      ] })
    ] }),
    x
  );
}
function Tt() {
  const { content: a, isOpen: i, close: t, host: n } = xe(), [l, u] = v(a);
  q(() => {
    a && u(a);
  }, [a]);
  const d = a ?? l, m = typeof d?.title == "string" ? d.title : "弹窗";
  return q(() => {
    if (!i) return;
    const c = (r) => {
      r.key === "Escape" && t();
    };
    return window.addEventListener("keydown", c), () => window.removeEventListener("keydown", c);
  }, [i, t]), n ? ke(
    /* @__PURE__ */ o("div", { className: `mk-inspector${i ? " is-open" : ""}`, "aria-hidden": !i, children: [
      /* @__PURE__ */ e("div", { className: "mk-inspector__scrim", onClick: t }),
      /* @__PURE__ */ o(
        "aside",
        {
          className: "mk-inspector__panel",
          role: "dialog",
          "aria-label": m,
          "aria-modal": "true",
          children: [
            /* @__PURE__ */ o("header", { className: "mk-inspector__head", children: [
              /* @__PURE__ */ o("div", { className: "mk-inspector__titles", children: [
                /* @__PURE__ */ e("div", { className: "mk-inspector__title", children: d?.title ?? "弹窗" }),
                d?.subtitle ? /* @__PURE__ */ e("div", { className: "mk-inspector__subtitle", children: d.subtitle }) : null
              ] }),
              /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "mk-inspector__close",
                  onClick: t,
                  "aria-label": "关闭",
                  children: "×"
                }
              )
            ] }),
            /* @__PURE__ */ e("div", { className: "mk-inspector__body", children: d?.body }),
            d?.footer ? /* @__PURE__ */ e("footer", { className: "mk-inspector__foot", children: d.footer }) : null
          ]
        }
      )
    ] }),
    n
  ) : null;
}
function Et(a) {
  const i = String(a || "").trim();
  return i ? i.split("/").pop() || i : "—";
}
function Lt(a) {
  const [i, t] = v(!0), [n, l] = v("—"), [u, d] = v("—"), [m, c] = v("…"), [r, x] = v("muted"), [k, h] = v("idle"), [y, s] = v(null), p = E(async () => {
    t(!0);
    let _ = {};
    try {
      _ = (await a.get("/smart-chat/config"))?.data || {};
    } catch {
      _ = {};
    }
    const C = Se(_), P = be(C, _.custom_vendors || []);
    l(String(P?.name || _.vendor || "—")), d(Et(String(_.model || ""))), t(!1);
    try {
      const $ = await Qa(a, _, { force: !1 });
      c($.label), x($.tone);
    } catch {
      c("—"), x("muted");
    }
  }, [a]), g = E(async () => {
    h("checking");
    try {
      const _ = await a.post("/smart-chat/test", {}), C = _.code === 0 && !!_.data?.ok;
      h(C ? "ok" : "fail"), s(typeof _.data?.latency_ms == "number" ? _.data.latency_ms : null);
    } catch {
      h("fail"), s(null);
    }
  }, [a]);
  return q(() => {
    p();
  }, [p]), {
    loading: i,
    vendorName: n,
    modelLabel: u,
    balanceLabel: m,
    balanceTone: r,
    conn: k,
    connLatency: y,
    refresh: p,
    probe: g
  };
}
const Rt = {
  idle: "未测",
  checking: "探测中",
  ok: "已连通",
  fail: "不可用"
};
function Je({
  label: a,
  value: i,
  tone: t = "muted",
  loading: n
}) {
  return /* @__PURE__ */ o("div", { className: `mk-topbar__tile mk-stat mk-stat--${t}`, children: [
    /* @__PURE__ */ e("span", { className: "mk-topbar__tile-label mk-stat__label", children: a }),
    /* @__PURE__ */ e(
      "span",
      {
        className: `mk-topbar__tile-value mk-stat__value${n ? " is-loading" : ""}`,
        title: !n && i ? i : void 0,
        children: n ? "···" : i || "—"
      }
    )
  ] });
}
function Pt({ status: a }) {
  const i = a.conn === "ok" && a.connLatency != null ? ` · ${a.connLatency}ms` : "";
  return /* @__PURE__ */ o(
    "button",
    {
      type: "button",
      className: `mk-conn mk-conn--${a.conn}`,
      onClick: () => void a.probe(),
      disabled: a.conn === "checking",
      title: "测试模型连通性",
      children: [
        /* @__PURE__ */ e("span", { className: "mk-conn__dot", "aria-hidden": !0 }),
        /* @__PURE__ */ o("span", { className: "mk-conn__text", children: [
          Rt[a.conn],
          i
        ] })
      ]
    }
  );
}
function It({
  nav: a,
  view: i,
  setView: t,
  api: n,
  children: l
}) {
  const u = Z(
    () => Math.max(0, a.findIndex((k) => k.id === i)),
    [a, i]
  ), d = je(u, a.length), m = Lt(n), [c, r] = v(!1);
  q(() => {
    const k = (h) => {
      (h.metaKey || h.ctrlKey) && (h.key === "k" || h.key === "K") && (h.preventDefault(), r((y) => !y));
    };
    return window.addEventListener("keydown", k), () => window.removeEventListener("keydown", k);
  }, []);
  let x = "";
  return /* @__PURE__ */ o("div", { className: "mk-console", children: [
    /* @__PURE__ */ o("aside", { className: "mk-console__aside", children: [
      /* @__PURE__ */ o("div", { className: "mk-brand", children: [
        /* @__PURE__ */ e("span", { className: "mk-brand__glyph", "aria-hidden": !0, children: "◇" }),
        /* @__PURE__ */ o("span", { className: "mk-brand__text", children: [
          /* @__PURE__ */ e("span", { className: "mk-brand__name", children: "智能对话" }),
          /* @__PURE__ */ e("span", { className: "mk-brand__sub", children: "独立 AI 控制台" })
        ] })
      ] }),
      /* @__PURE__ */ o("nav", { className: "mk-nav", ref: d.navRef, "aria-label": "主导航", children: [
        /* @__PURE__ */ e(
          "div",
          {
            className: `mk-nav__liquid${d.box.ready ? " is-ready" : ""}`,
            style: {
              transform: `translate3d(${d.box.left}px, ${d.box.top}px, 0)`,
              width: d.box.width,
              height: d.box.height
            },
            "aria-hidden": !0
          }
        ),
        a.map((k, h) => {
          const y = k.group && k.group !== x;
          k.group && (x = k.group);
          const s = i === k.id;
          return /* @__PURE__ */ o("div", { className: "mk-nav__slot", children: [
            y ? /* @__PURE__ */ e("div", { className: "mk-nav__group", children: k.group }) : null,
            /* @__PURE__ */ o(
              "button",
              {
                type: "button",
                ref: (p) => d.setItemRef(h, p),
                className: `mk-nav__item${s ? " is-active" : ""}`,
                onClick: () => t(k.id),
                "aria-current": s ? "page" : void 0,
                children: [
                  /* @__PURE__ */ e("span", { className: "mk-nav__dot", "aria-hidden": !0 }),
                  /* @__PURE__ */ e("span", { className: "mk-nav__label", children: k.label })
                ]
              }
            )
          ] }, k.id);
        })
      ] }),
      /* @__PURE__ */ e("div", { className: "mk-console__aside-foot", children: /* @__PURE__ */ e(Pt, { status: m }) })
    ] }),
    /* @__PURE__ */ o("div", { className: "mk-console__body", children: [
      /* @__PURE__ */ e("header", { className: "mk-topbar", children: /* @__PURE__ */ o("div", { className: "mk-topbar__stats", children: [
        /* @__PURE__ */ e(Je, { label: "厂商", value: m.vendorName, loading: m.loading }),
        /* @__PURE__ */ e(Je, { label: "模型", value: m.modelLabel, loading: m.loading }),
        /* @__PURE__ */ e(
          Je,
          {
            label: "余额",
            value: m.balanceLabel,
            tone: m.balanceTone,
            loading: m.loading
          }
        ),
        /* @__PURE__ */ o(
          "button",
          {
            type: "button",
            className: "mk-topbar__tile mk-topbar__cmdk",
            onClick: () => r(!0),
            title: "命令面板 (Ctrl/⌘ K)",
            children: [
              /* @__PURE__ */ e("span", { className: "mk-topbar__tile-label", children: "命令" }),
              /* @__PURE__ */ o("span", { className: "mk-topbar__tile-value", children: [
                /* @__PURE__ */ e("span", { "aria-hidden": !0, children: "⌘" }),
                "K"
              ] })
            ]
          }
        ),
        /* @__PURE__ */ o(
          "button",
          {
            type: "button",
            className: "mk-topbar__tile mk-topbar__refresh",
            onClick: () => void m.refresh(),
            title: "刷新状态",
            "aria-label": "刷新状态",
            children: [
              /* @__PURE__ */ e("span", { className: "mk-topbar__tile-label", children: "刷新" }),
              /* @__PURE__ */ e("span", { className: "mk-topbar__tile-value", "aria-hidden": !0, children: "⟳" })
            ]
          }
        )
      ] }) }),
      /* @__PURE__ */ e("main", { className: "mk-console__main", children: /* @__PURE__ */ e("div", { className: "mk-console__page", children: l }, i) }),
      /* @__PURE__ */ e(Tt, {})
    ] }),
    /* @__PURE__ */ e(
      zt,
      {
        open: c,
        onClose: () => r(!1),
        nav: a,
        setView: t,
        status: m
      }
    )
  ] });
}
function At() {
  const { content: a, isOpen: i, close: t, host: n } = xe(), [l, u] = v(a);
  q(() => {
    a && u(a);
  }, [a]), q(() => {
    if (!i) return;
    const c = (r) => {
      r.key === "Escape" && t();
    };
    return window.addEventListener("keydown", c), () => window.removeEventListener("keydown", c);
  }, [i, t]);
  const d = a ?? l, m = typeof d?.title == "string" ? d.title : "弹窗";
  return n ? ke(
    /* @__PURE__ */ o("div", { className: `mk-sheet${i ? " is-open" : ""}`, "aria-hidden": !i, children: [
      /* @__PURE__ */ e("div", { className: "mk-sheet__scrim", onClick: t }),
      /* @__PURE__ */ o(
        "section",
        {
          className: "mk-sheet__panel",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": m,
          children: [
            d?.title ? /* @__PURE__ */ o("header", { className: "mk-sheet__head", children: [
              /* @__PURE__ */ o("div", { className: "mk-sheet__titles", children: [
                /* @__PURE__ */ e("div", { className: "mk-sheet__title", children: d.title }),
                d?.subtitle ? /* @__PURE__ */ e("div", { className: "mk-sheet__subtitle", children: d.subtitle }) : null
              ] }),
              /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "mk-sheet__close",
                  onClick: t,
                  "aria-label": "关闭",
                  children: "×"
                }
              )
            ] }) : null,
            /* @__PURE__ */ e("div", { className: "mk-sheet__body", children: d?.body }),
            d?.footer ? /* @__PURE__ */ e("footer", { className: "mk-sheet__foot", children: d.footer }) : null
          ]
        }
      )
    ] }),
    n
  ) : null;
}
const qt = [
  { key: "overview", label: "总览", glyph: "◈" },
  { key: "switch", label: "开关", glyph: "◉" },
  { key: "sessions", label: "会话", glyph: "❒" },
  { key: "config", label: "配置", glyph: "⚙" },
  { key: "more", label: "更多", glyph: "⋯" }
], Ot = [
  { id: "model", label: "模型" },
  { id: "policy", label: "策略" },
  { id: "skills", label: "能力" },
  { id: "rotation", label: "轮替" }
], Bt = [
  { id: "voice", label: "语音输出", desc: "配音密钥与角色设置" },
  { id: "blacklist", label: "黑户管理", desc: "拉黑或恢复用户" }
], Kt = ["model", "policy", "skills", "rotation"];
function jt(a) {
  return a === "overview" ? "overview" : a === "switch" ? "switch" : a === "sessions" ? "sessions" : a === "blacklist" || a === "voice" ? "more" : "config";
}
function Dt({
  view: a,
  setView: i,
  children: t
}) {
  const n = xe(), l = jt(a), u = l === "config", d = E(() => {
    n.open({
      key: "more",
      title: "更多",
      subtitle: "其余管理入口",
      body: /* @__PURE__ */ e("div", { className: "mk-sheet-list", children: Bt.map((c) => /* @__PURE__ */ o(
        "button",
        {
          type: "button",
          className: "mk-sheet-list__item",
          onClick: () => {
            i(c.id), n.close();
          },
          children: [
            /* @__PURE__ */ e("span", { className: "mk-sheet-list__label", children: c.label }),
            /* @__PURE__ */ e("span", { className: "mk-sheet-list__desc", children: c.desc })
          ]
        },
        c.id
      )) })
    });
  }, [n, i]), m = E(
    (c) => {
      if (c === "more") {
        d();
        return;
      }
      if (c === "config") {
        Kt.includes(a) || i("model");
        return;
      }
      if (c === "overview") {
        i("overview");
        return;
      }
      i(c === "switch" ? "switch" : "sessions");
    },
    [d, i, a]
  );
  return /* @__PURE__ */ o("div", { className: "mk-ios", children: [
    u ? /* @__PURE__ */ e("header", { className: "mk-ios__nav", children: /* @__PURE__ */ e("div", { className: "mk-ios__segment", role: "tablist", "aria-label": "配置分段", children: Ot.map((c) => /* @__PURE__ */ e(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": a === c.id,
        className: a === c.id ? "is-active" : "",
        onClick: () => i(c.id),
        children: c.label
      },
      c.id
    )) }) }) : null,
    /* @__PURE__ */ e("main", { className: "mk-ios__scroll", children: /* @__PURE__ */ e("div", { className: "mk-ios__page", children: t }, a) }),
    /* @__PURE__ */ e("nav", { className: "mk-ios__tabbar", "aria-label": "主导航", children: qt.map((c) => {
      const r = l === c.key;
      return /* @__PURE__ */ o(
        "button",
        {
          type: "button",
          className: `mk-ios__tab${r ? " is-active" : ""}`,
          "aria-current": r ? "page" : void 0,
          onClick: () => m(c.key),
          children: [
            /* @__PURE__ */ e("span", { className: "mk-ios__tab-glyph", "aria-hidden": !0, children: c.glyph }),
            /* @__PURE__ */ e("span", { className: "mk-ios__tab-label", children: c.label })
          ]
        },
        c.key
      );
    }) }),
    /* @__PURE__ */ e(At, {})
  ] });
}
const Ut = [
  { id: "overview", label: "数据总览", short: "总览", group: "总览" },
  { id: "model", label: "模型接入", short: "模型", group: "配置" },
  { id: "policy", label: "对话策略", short: "策略", group: "配置" },
  { id: "skills", label: "能力扩展", short: "能力", group: "配置" },
  { id: "voice", label: "语音输出", short: "语音", group: "配置" },
  { id: "rotation", label: "模型轮替", short: "轮替", group: "配置" },
  { id: "blacklist", label: "黑户管理", short: "黑户", group: "运维" },
  { id: "switch", label: "聊天开关", short: "开关", group: "运维" },
  { id: "sessions", label: "会话管理", short: "会话", group: "运维" }
];
function Ft({
  view: a,
  api: i,
  toast: t,
  confirm: n
}) {
  return a === "overview" ? /* @__PURE__ */ e(_t, { api: i }) : a === "switch" ? /* @__PURE__ */ e(St, { api: i, toast: t }) : a === "voice" ? /* @__PURE__ */ e(Mt, { api: i, toast: t }) : a === "blacklist" ? /* @__PURE__ */ e(Ni, { api: i, toast: t, confirm: n }) : a === "sessions" ? /* @__PURE__ */ e(wt, { api: i, toast: t, confirm: n }) : /* @__PURE__ */ e(Fi, { api: i, toast: t, confirm: n, section: a });
}
function Qt({
  api: a,
  toast: i,
  confirm: t
}) {
  const n = Ke(), [l, u] = v("overview"), d = /* @__PURE__ */ e(Ft, { view: l, api: a, toast: i, confirm: t });
  return n === "desktop" ? /* @__PURE__ */ e(It, { nav: Ut, view: l, setView: u, api: a, children: d }) : /* @__PURE__ */ e(Dt, { view: l, setView: u, children: d });
}
const za = 16, Ta = 0.2;
function Ea(a) {
  return !a || typeof a.closest != "function" ? !1 : !!a.closest(
    'button, a, input, textarea, select, label, [role="button"], [role="switch"], .nav-btn'
  );
}
function Wt({ rootRef: a }) {
  const i = typeof window < "u" && ("ontouchstart" in window || (navigator?.maxTouchPoints ?? 0) > 0), t = j(null), n = j(0), l = j({ x: -100, y: -100 }), u = j({ x: -100, y: -100 }), d = j(!1);
  return q(() => {
    if (i) return;
    const m = a.current, c = t.current;
    if (!m || !c) return;
    m.classList.add("mkai-cursor-on");
    const r = () => {
      d.current = !0, c.style.opacity = "1";
    }, x = () => {
      d.current = !1, c.style.opacity = "0";
    }, k = (C) => {
      l.current.x = C.clientX, l.current.y = C.clientY, d.current || (u.current.x = C.clientX, u.current.y = C.clientY, r());
    }, h = (C) => {
      Ea(C.target) && c.classList.add("is-active");
    }, y = (C) => {
      Ea(C.relatedTarget) || c.classList.remove("is-active");
    }, s = () => c.classList.add("is-press"), p = () => c.classList.remove("is-press"), g = () => x();
    m.addEventListener("mousemove", k), m.addEventListener("mouseover", h), m.addEventListener("mouseout", y), m.addEventListener("mousedown", s), m.addEventListener("mouseup", p), m.addEventListener("mouseleave", g);
    const _ = () => {
      const C = l.current, P = u.current;
      P.x += (C.x - P.x) * Ta, P.y += (C.y - P.y) * Ta, c.style.transform = `translate3d(${P.x - za}px, ${P.y - za}px, 0)`, n.current = requestAnimationFrame(_);
    };
    return n.current = requestAnimationFrame(_), () => {
      cancelAnimationFrame(n.current), m.classList.remove("mkai-cursor-on"), m.removeEventListener("mousemove", k), m.removeEventListener("mouseover", h), m.removeEventListener("mouseout", y), m.removeEventListener("mousedown", s), m.removeEventListener("mouseup", p), m.removeEventListener("mouseleave", g);
    };
  }, [i, a]), i ? null : /* @__PURE__ */ o("div", { ref: t, className: "mkai-cursor", "aria-hidden": !0, style: { opacity: 0 }, children: [
    /* @__PURE__ */ e("span", { className: "mkai-cursor__ring" }),
    /* @__PURE__ */ e("span", { className: "mkai-cursor__dot" })
  ] });
}
const Xa = La(null);
function Gt(a, i) {
  return i || (/失败|异常|错误|error|拒绝|不可用|无法/i.test(a) ? "err" : /成功|已保存|已清空|已删除|已移除|已加入|正常|通过|完成|已开启|已关闭/i.test(a) ? "ok" : (/请|注意|标记|打开|切换为/i.test(a), "info"));
}
const Vt = {
  ok: "成功",
  err: "异常",
  info: "提示",
  warn: "注意"
};
function Yt({ children: a }) {
  const [i, t] = v([]), [n, l] = v(null), u = j(1), { host: d } = xe(), m = E((s) => {
    t((p) => p.filter((g) => g.id !== s));
  }, []), c = E((s, p) => {
    const g = String(s || "").trim();
    if (!g) return;
    const _ = u.current++, C = { id: _, msg: g, kind: Gt(g, p) };
    t((P) => [...P.slice(-3), C]), window.setTimeout(() => m(_), C.kind === "err" ? 3600 : 2400);
  }, [m]), r = E((s) => {
    const p = typeof s == "string" ? { message: s } : s;
    return new Promise((g) => {
      l({ ...p, resolve: g });
    });
  }, []), x = Z(() => ({ toast: c, confirm: r }), [c, r]), k = (s) => {
    n?.resolve(s), l(null);
  }, h = /* @__PURE__ */ e("div", { className: "mk-toast-stack", "aria-live": "polite", "aria-relevant": "additions", children: i.map((s) => /* @__PURE__ */ o("div", { className: `mk-toast mk-toast--${s.kind}`, role: "status", children: [
    /* @__PURE__ */ e("span", { className: "mk-toast__badge", children: Vt[s.kind] }),
    /* @__PURE__ */ e("span", { className: "mk-toast__msg", children: s.msg }),
    /* @__PURE__ */ e("button", { type: "button", className: "mk-toast__close", "aria-label": "关闭", onClick: () => m(s.id), children: "×" })
  ] }, s.id)) }), y = n ? /* @__PURE__ */ e(
    "div",
    {
      className: "mk-modal-overlay mk-confirm-overlay",
      onClick: (s) => {
        s.target === s.currentTarget && k(!1);
      },
      children: /* @__PURE__ */ o("div", { className: "mk-modal mk-confirm mk-modal--enter", role: "alertdialog", "aria-modal": "true", children: [
        /* @__PURE__ */ e("h3", { className: "mk-modal__title", children: n.title || "请确认" }),
        /* @__PURE__ */ e("p", { className: "mk-confirm__msg", children: n.message }),
        /* @__PURE__ */ o("div", { className: "mk-btn-row", children: [
          /* @__PURE__ */ e(
            "button",
            {
              type: "button",
              className: `mk-btn ${n.danger ? "mk-btn--danger" : "mk-btn--primary"}`,
              onClick: () => k(!0),
              children: n.okText || "确定"
            }
          ),
          /* @__PURE__ */ e("button", { type: "button", className: "mk-btn mk-btn--ghost", onClick: () => k(!1), children: n.cancelText || "取消" })
        ] })
      ] })
    }
  ) : null;
  return /* @__PURE__ */ o(Xa.Provider, { value: x, children: [
    a,
    d ? ke(h, d) : null,
    d && n ? ke(y, d) : null
  ] });
}
function Ht() {
  const a = Ra(Xa);
  return a || {
    toast: (i) => {
      console.warn("[mkai notify]", i);
    },
    confirm: async () => !1
  };
}
const Jt = '.mkai-admin{--mk-text: #0f172a;--mk-text-muted: #64748b;--mk-muted: #94a3b8;--mk-primary: #0f766e;--mk-success: #16a34a;--mk-safe-bottom: env(safe-area-inset-bottom, 0px);--sidebar-w: 200px;--font: "Manrope", "PingFang SC", "Microsoft YaHei", sans-serif;--btn-h: 40px;--btn-h-sm: 34px;--panel-bg: rgba(255, 255, 255, .78);--panel-border: rgba(15, 23, 42, .08);--panel-shadow: 0 10px 28px rgba(15, 40, 60, .07);--input-bg: #ffffff;--input-border: rgba(15, 23, 42, .14);--input-focus: rgba(20, 184, 166, .22);--btn-ghost-bg: #eef4f3;--btn-ghost-border: rgba(15, 23, 42, .12);--btn-ghost-hover: #e2ecea;--glass-bg: var(--panel-bg);--glass-bg-strong: rgba(255, 255, 255, .88);--glass-bg-soft: rgba(255, 255, 255, .45);--glass-bg-hover: rgba(255, 255, 255, .92);--glass-border: var(--panel-border);--glass-border-soft: rgba(15, 23, 42, .06);--glass-blur: 18px;--glass-blur-xl: 24px;--glass-shadow: var(--panel-shadow);--glass-pill-active-bg: rgba(20, 184, 166, .16);--glass-pill-active-border: rgba(20, 184, 166, .38);--glass-pill-active-shadow: 0 4px 14px rgba(20, 184, 166, .12);--glass-pill-active-text: #0f766e;--mk-surface: var(--panel-bg);--mk-border: var(--panel-border);--mk-bg: transparent;box-sizing:border-box;display:flex;min-height:100%;height:100%;color:var(--mk-text);font-family:var(--font);overflow:hidden;background:radial-gradient(900px 520px at 8% -6%,rgba(20,184,166,.16),transparent 55%),radial-gradient(780px 480px at 96% 4%,rgba(45,212,191,.12),transparent 52%),radial-gradient(640px 420px at 70% 18%,rgba(125,211,252,.1),transparent 50%),linear-gradient(160deg,#dce8ef,#e4ecf4 42%,#e8f2f0)}.mkai-admin *,.mkai-admin *:before,.mkai-admin *:after{box-sizing:border-box}.mk-overlay-host.mkai-admin{position:fixed;inset:0;z-index:var(--mk-z-portal);pointer-events:none;display:block;overflow:visible;min-height:0;height:auto;padding:0;border:none;box-shadow:none;background:transparent!important}.mk-overlay-host>*{pointer-events:auto}.mkai-admin,.mkai-admin *{scrollbar-width:none;-ms-overflow-style:none}.mkai-admin::-webkit-scrollbar,.mkai-admin *::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;background:transparent}.mkai-admin .mk-input--secret{-webkit-text-security:disc;text-security:disc}.mkai-admin .mk-input--ok{border-color:#16a34a8c!important;box-shadow:0 0 0 3px #16a34a1f}.mkai-admin .mk-input--ok:focus{border-color:#16a34ab3!important;box-shadow:0 0 0 3px #16a34a2e}.mkai-admin .mk-input--err{border-color:#dc262699!important;box-shadow:0 0 0 3px #dc26261f}.mkai-admin .mk-input--err:focus{border-color:#dc2626bf!important;box-shadow:0 0 0 3px #dc26262e}.mkai-admin .vendor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.mkai-admin .vendor-card{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;padding:14px 14px 12px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;cursor:pointer;font:inherit;transition:border-color .22s ease,box-shadow .22s ease,transform .18s ease,background .22s ease}.mkai-admin .vendor-card:hover{transform:translateY(-1px);border-color:#14b8a659;box-shadow:0 6px 16px #0f283c14}.mkai-admin .vendor-card.is-active{border-color:#14b8a68c;background:linear-gradient(145deg,#fff,#f0fdfa);box-shadow:0 0 0 1px #14b8a61f,0 8px 18px #14b8a61f}.mkai-admin .vendor-card__name{font-size:14px;font-weight:750;color:#0f172a}.mkai-admin .vendor-card__name-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%}.mkai-admin .vendor-card__tag{flex-shrink:0;font-size:9px;font-weight:800;letter-spacing:.02em;color:#0f766e;background:#14b8a61f;border:1px solid rgba(45,212,191,.35);border-radius:999px;padding:1px 6px;line-height:1.3}.mkai-admin .vendor-card.is-active .vendor-card__name{color:#0f766e}.mkai-admin .vendor-card__model{font-size:11px;color:#64748b;word-break:break-all;line-height:1.35}.mkai-admin .vendor-card--custom{position:relative;border-style:dashed}.mkai-admin .vendor-card--add{position:relative;align-items:center;justify-content:center;min-height:86px;border-style:dashed;border-color:#0f766e47;background:#f0fdfa8c}.mkai-admin .vendor-card__corner{position:absolute;top:8px;right:8px;font-size:9px;font-weight:800;letter-spacing:.02em;color:#0f766e;background:#14b8a61f;border:1px solid rgba(45,212,191,.35);border-radius:999px;padding:1px 6px;line-height:1.3}.mkai-admin .vendor-card__plus{width:40px;height:40px;border-radius:999px;display:grid;place-items:center;font-size:26px;font-weight:700;line-height:1;color:#0f766e;background:#14b8a624;border:1px solid rgba(45,212,191,.4)}.mkai-admin .vendor-card__corner--anthropic{color:#7c2d12;background:#fb923c24;border-color:#fb923c73}.mkai-admin .vendor-card__tag--anthropic{color:#7c2d12;background:#fb923c1f;border-color:#fb923c59}.mkai-admin .mk-input-with-action{position:relative;display:flex;align-items:stretch}.mkai-admin .mk-input-with-action .mk-input{flex:1;padding-right:42px}.mkai-admin .mk-input-with-action__btn{position:absolute;top:50%;right:6px;transform:translateY(-50%);width:30px;height:30px;border-radius:8px;border:1px solid rgba(15,23,42,.12);background:#f0fdfae6;color:#0f766e;font-size:16px;font-weight:700;line-height:1;cursor:pointer;display:grid;place-items:center}.mkai-admin .mk-input-with-action__btn:hover:not(:disabled){border-color:#14b8a673;background:#ccfbf1f2}.mkai-admin .mk-input-with-action__btn:disabled{opacity:.55;cursor:not-allowed}.mkai-admin .mk-model-picker{position:relative}.mkai-admin .mk-model-list{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:45;margin:0;border:1px solid rgba(15,23,42,.14);border-radius:12px;background:#fff;box-shadow:0 10px 28px #0f283c24,0 0 0 1px #0f172a0a;overflow:hidden}.mkai-admin .mk-model-list__head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;font-size:11px;font-weight:650;color:#64748b;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.08)}.mkai-admin .mk-model-list__close{width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:#64748b;font-size:16px;line-height:1;cursor:pointer;display:grid;place-items:center}.mkai-admin .mk-model-list__close:hover{background:#0f172a0f;color:#0f172a}.mkai-admin .mk-model-list__items{margin:0;padding:0;list-style:none;max-height:220px;overflow:auto}.mkai-admin .mk-model-list__item{display:block;width:100%;text-align:left;padding:7px 10px;border:none;border-bottom:1px solid rgba(15,23,42,.06);background:transparent;font:inherit;font-size:12px;color:#0f172a;cursor:pointer}.mkai-admin .mk-model-list__item:hover,.mkai-admin .mk-model-list__item[aria-selected=true]{background:#14b8a614}.mkai-admin .mk-model-list__items li:last-child .mk-model-list__item{border-bottom:none}.mkai-admin .mk-probe-log{margin:0;min-height:96px;max-height:260px;overflow:auto;padding:12px 14px;border-radius:12px;border:1px solid rgba(15,23,42,.12);background:#0f172a;color:#e2e8f0;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.mkai-admin .im-avatar-img{width:44px;height:44px;border-radius:999px;object-fit:cover;background:#e2e8f08c;border:1px solid rgba(255,255,255,.35);flex-shrink:0}.mkai-admin .im-msg .im-avatar-img{width:36px;height:36px}.mkai-admin .im-msg.out .im-avatar-img{order:2}.mkai-admin .bl-add-row{display:grid;grid-template-columns:1fr minmax(96px,120px);gap:10px;align-items:center}.mkai-admin .bl-list{display:flex;flex-direction:column;gap:8px}.mkai-admin .bl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.1)}.mkai-admin .bl-row__id{font-weight:700;font-variant-numeric:tabular-nums;color:#0f172a}.mkai-admin .sidebar{width:var(--sidebar-w);flex-shrink:0;display:flex;flex-direction:column;gap:4px;padding:18px 12px;background:#ffffff47;backdrop-filter:blur(var(--glass-blur-xl)) saturate(1.3);-webkit-backdrop-filter:blur(var(--glass-blur-xl)) saturate(1.3);border-right:1px solid rgba(255,255,255,.45);overflow:auto}.mkai-admin .brand{font-weight:800;font-size:1.25rem;padding:8px 10px 18px;line-height:1.15}.mkai-admin .brand .mark{background:linear-gradient(120deg,#0f766e 10%,#14b8a6,#0ea5e9);-webkit-background-clip:text;background-clip:text;color:transparent}.mkai-admin .brand small{display:block;font-size:.72rem;font-weight:600;color:var(--mk-text-muted);margin-top:6px}.mkai-admin .sidebar-nav{position:relative;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}.mkai-admin .nav-liquid{position:absolute;top:0;left:0;z-index:0;pointer-events:none;border-radius:.95rem;opacity:0;will-change:transform,width,height;background:#14b8a62e;border:1px solid rgba(20,184,166,.42);-webkit-backdrop-filter:blur(10px) saturate(1.4);backdrop-filter:blur(10px) saturate(1.4);box-shadow:0 8px 22px #14b8a624,inset 0 1px #ffffffd9,inset 0 -1px #14b8a614;transition:transform .48s cubic-bezier(.32,.72,0,1),width .48s cubic-bezier(.32,.72,0,1),height .48s cubic-bezier(.32,.72,0,1),opacity .2s ease}.mkai-admin .nav-liquid.is-ready{opacity:1}.mkai-admin .nav-liquid:after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(135deg,rgba(255,255,255,.45) 0%,transparent 42%,transparent 100%);pointer-events:none}.mkai-admin .nav-slot{position:relative;z-index:1}.mkai-admin .nav-btn{position:relative;z-index:1;width:100%;border:1px solid transparent;background:transparent;text-align:left;padding:10px 14px;border-radius:.95rem;cursor:pointer;color:#64748b;font:inherit;font-weight:600;letter-spacing:.04em;transition:color .35s ease,transform .3s cubic-bezier(.22,1,.36,1),border-color .3s ease}.mkai-admin .nav-btn:hover{color:#0f172a;background:#ffffff61;border-color:#ffffff73;transform:scale(1.02)}.mkai-admin .nav-btn.is-active{background:transparent;border-color:transparent;color:#0f766e;font-weight:700;box-shadow:none}.mkai-admin .nav-btn:active{transform:scale(.98)}.mkai-admin .main{flex:1;min-width:0;overflow:auto;padding:20px 24px 32px;width:100%}.mkai-admin .nav-label{font-size:10px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:#64748bbf;padding:14px 12px 6px}.mkai-admin .page-head,.mkai-admin .page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}.mkai-admin .page-title{margin:0;font-size:1.4rem;font-weight:800;color:#0f172a;letter-spacing:-.02em}.mkai-admin .page-desc{margin:6px 0 0;font-size:13px;color:#64748b;line-height:1.45;width:100%}.mkai-admin .page-toolbar{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(96px,1fr);gap:8px;flex-shrink:0;min-width:min(280px,100%)}.mkai-admin .page-toolbar>.mk-btn{width:100%}.mkai-admin .toolbar__actions{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(96px,1fr);gap:8px}.mkai-admin .toolbar__actions>.mk-btn{width:100%}.mkai-admin .chip--warn{color:#b45309;background:#f59e0b24;border-color:#f59e0b47}.mkai-admin .toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}.mkai-admin .toolbar__actions{display:flex;flex-wrap:wrap;gap:8px}.mkai-admin .sw-tabbar{display:flex;justify-content:center;margin-bottom:14px;width:100%}.mkai-admin .seg{position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;padding:5px;border-radius:14px;background:#ffffff8c;border:1px solid rgba(15,23,42,.1);width:100%;max-width:none;box-shadow:0 2px 10px #0f283c0a}.mkai-admin .seg--center{margin:0 auto;width:100%}.mkai-admin .seg__btn{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;height:38px;border:1px solid transparent;background:transparent;border-radius:10px;padding:0 18px;font:inherit;font-size:14px;font-weight:650;color:#64748b;cursor:pointer;transition:color .35s ease;white-space:nowrap}.mkai-admin .seg__btn:hover{color:#0f172a}.mkai-admin .seg__btn.is-active{background:transparent;border-color:transparent;color:#0f766e;box-shadow:none}.mkai-admin .panel{background:var(--panel-bg);backdrop-filter:blur(var(--glass-blur)) saturate(1.2);-webkit-backdrop-filter:blur(var(--glass-blur)) saturate(1.2);border:1px solid var(--panel-border);border-radius:16px;box-shadow:var(--panel-shadow);padding:18px 20px 16px;margin-bottom:14px;width:100%}.mkai-admin .panel--flush{padding:10px}.mkai-admin .panel-title{margin:0 0 14px;font-size:14px;font-weight:750;color:#0f172a}.mkai-admin .panel+.panel{margin-top:0}.mkai-admin .status-strip{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.mkai-admin .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:600;color:#334155;background:#eef2f7;border:1px solid rgba(15,23,42,.1)}.mkai-admin .chip strong{font-weight:700;color:#0f172a}.mkai-admin .chip--muted{color:#64748b}.mkai-admin .chip--ok{color:#15803d;background:#16a34a1f;border-color:#16a34a38}.mkai-admin .chip--off{color:#64748b;background:#94a3b833}.mkai-admin .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}.mkai-admin .form-grid--3{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.mkai-admin .field-span-2{grid-column:1 / -1}.mkai-admin .switch-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.28)}.mkai-admin .switch-row:last-of-type{border-bottom:0}.mkai-admin .switch-row__title{font-size:14px;font-weight:650;color:#1e293b}.mkai-admin .switch-row__desc{font-size:12px;color:#64748b;margin-top:3px;line-height:1.4}.mkai-admin .switch-row__cap{display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0}.mkai-admin .mkai-page-config,.mkai-admin .mkai-page-switch{width:100%;max-width:none}.mkai-admin .glass-card{background:var(--panel-bg);backdrop-filter:blur(var(--glass-blur-xl)) saturate(1.2);-webkit-backdrop-filter:blur(var(--glass-blur-xl)) saturate(1.2);border:1px solid var(--panel-border);border-radius:1rem;box-shadow:var(--panel-shadow);overflow:hidden;display:flex;flex-direction:column;gap:0;width:100%}.mkai-admin .mk-panel-head{padding:18px 22px 12px;border-bottom:1px solid rgba(255,255,255,.28);background:transparent}.mkai-admin .mk-panel-body{padding:18px 22px 22px}.mkai-admin .mk-title-lg{margin:0;font-size:1.2rem;font-weight:750;color:#0f172a}.mkai-admin .mk-label{display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:#64748b;letter-spacing:.01em}.mkai-admin .mk-hint{font-size:12px;color:var(--mk-text-muted);line-height:1.45}.mkai-admin .mk-form-group{margin-bottom:12px}.mkai-admin .mk-input{width:100%;border:1px solid var(--input-border);background:var(--input-bg);border-radius:12px;padding:11px 14px;min-height:var(--btn-h);font:inherit;color:#0f172a;outline:none;transition:background .18s ease,border-color .18s ease,box-shadow .18s ease;box-shadow:inset 0 1px 2px #0f172a0a}.mkai-admin textarea.mk-input{min-height:160px;line-height:1.5;resize:vertical;overflow:auto;margin-top:8px}.mkai-admin textarea.mk-input--prompt{min-height:220px}.mkai-admin .mk-input::placeholder{color:#94a3b8}.mkai-admin .mk-input:focus{background:#fff;border-color:#14b8a68c;box-shadow:0 0 0 3px var(--input-focus)}.mkai-admin input.mk-input[type=password]{letter-spacing:.12em}.mkai-admin select.mk-input{appearance:none;-webkit-appearance:none;background-color:var(--input-bg);background-image:linear-gradient(45deg,transparent 50%,rgba(100,116,139,.7) 50%),linear-gradient(135deg,rgba(100,116,139,.7) 50%,transparent 50%);background-position:calc(100% - 18px) calc(50% - 3px),calc(100% - 12px) calc(50% - 3px);background-size:6px 6px,6px 6px;background-repeat:no-repeat;padding-right:36px}.mkai-admin .mk-btn{display:inline-flex;align-items:center;justify-content:center;text-align:center;height:var(--btn-h);min-height:var(--btn-h);min-width:0;padding:0 14px;border:1px solid transparent;border-radius:12px;font:inherit;font-size:13px;font-weight:650;line-height:1;white-space:nowrap;cursor:pointer;transition:background .18s ease,border-color .18s ease,transform .18s ease,box-shadow .18s ease,color .18s ease,filter .18s ease}.mkai-admin .mk-btn--primary{background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff;border-color:#14b8a673;box-shadow:0 4px 12px #0f766e3d}.mkai-admin .mk-btn--primary:hover{filter:brightness(1.05);transform:translateY(-1px)}.mkai-admin .mk-btn--primary:disabled{opacity:.55;cursor:not-allowed;transform:none}.mkai-admin .mk-btn--ghost{background:var(--btn-ghost-bg);border-color:var(--btn-ghost-border);color:#334155;box-shadow:none}.mkai-admin .mk-btn--ghost:hover{background:var(--btn-ghost-hover);color:#0f172a;transform:translateY(-1px)}.mkai-admin .mk-btn--sm{height:var(--btn-h-sm);min-height:var(--btn-h-sm);padding:0 12px;font-size:12px;border-radius:10px}.mkai-admin .mk-btn-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:14px;width:100%}.mkai-admin .mk-btn-row>.mk-btn{width:100%}.mkai-admin .mk-seg{display:flex;flex-wrap:wrap;gap:6px}.mkai-admin .mk-form-group>.mk-seg{margin-top:6px}.mkai-admin .mk-seg--fill{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;flex-wrap:nowrap;gap:6px;width:100%;padding:5px;border-radius:14px;background:#ffffff8c;border:1px solid rgba(15,23,42,.1);box-shadow:0 2px 10px #0f283c0a}.mkai-admin .mk-seg--fill .mk-seg__btn{width:100%;text-align:center;padding:9px 10px}.mkai-admin .mk-seg__btn{border:1px solid transparent;background:transparent;border-radius:12px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;color:#64748b;transition:color .18s ease,background .18s ease,border-color .18s ease,box-shadow .18s ease}.mkai-admin .mk-seg__btn:hover{color:#334155;background:#fff3}.mkai-admin .mk-seg__btn--active{background:var(--glass-pill-active-bg);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-color:var(--glass-pill-active-border);color:var(--glass-pill-active-text);font-weight:650;box-shadow:var(--glass-pill-active-shadow)}.mkai-admin .mk-cs-tab-panel{display:none}.mkai-admin .mk-cs-tab-panel.is-active{display:block}.mkai-admin .mk-link-out{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:5px 12px;border-radius:999px;border:1px solid var(--glass-pill-active-border);background:var(--glass-pill-active-bg);color:var(--glass-pill-active-text);font-size:12px;font-weight:650;text-decoration:none;transition:box-shadow .18s ease,transform .18s ease}.mkai-admin .mk-link-out:hover{box-shadow:var(--glass-pill-active-shadow);transform:translateY(-1px)}.mkai-admin .mk-link-out__arrow{font-size:11px;opacity:.8}.mkai-admin .mk-toast-stack{position:fixed;right:18px;bottom:calc(18px + var(--mk-safe-bottom));z-index:80;display:flex;flex-direction:column-reverse;gap:10px;width:min(360px,calc(100vw - 28px));pointer-events:none}.mkai-admin .mk-toast{pointer-events:auto;display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:10px;padding:12px 12px 12px 14px;border-radius:14px;background:#ffffffeb;border:1px solid rgba(15,23,42,.1);box-shadow:0 12px 32px #0f283c24;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);animation:mkai-fade-up .28s cubic-bezier(.22,1,.36,1);color:#0f172a;font-size:13px;line-height:1.45}.mkai-admin .mk-toast__badge{display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:22px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:750;flex-shrink:0}.mkai-admin .mk-toast__msg{min-width:0;padding-top:1px;word-break:break-word}.mkai-admin .mk-toast__close{border:0;background:transparent;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1;padding:0 2px}.mkai-admin .mk-toast--ok{border-color:#16a34a47;background:linear-gradient(145deg,#fff,#f0fdf4)}.mkai-admin .mk-toast--ok .mk-toast__badge{color:#15803d;background:#16a34a24}.mkai-admin .mk-toast--err{border-color:#dc262647;background:linear-gradient(145deg,#fff,#fef2f2)}.mkai-admin .mk-toast--err .mk-toast__badge{color:#b91c1c;background:#dc26261f}.mkai-admin .mk-toast--warn{border-color:#d977064d;background:linear-gradient(145deg,#fff,#fffbeb)}.mkai-admin .mk-toast--warn .mk-toast__badge{color:#b45309;background:#f59e0b29}.mkai-admin .mk-toast--info{border-color:#14b8a647;background:linear-gradient(145deg,#fff,#f0fdfa)}.mkai-admin .mk-toast--info .mk-toast__badge{color:#0f766e;background:#14b8a624}.mkai-admin .mk-confirm-overlay{z-index:90}.mkai-admin .mk-confirm{max-width:min(420px,96vw)}.mkai-admin .mk-confirm__msg{margin:0 0 16px;color:#475569;font-size:14px;line-height:1.55;white-space:pre-wrap}.mkai-admin .mk-btn--danger{background:#dc2626;color:#fff;border-color:#b91c1c;box-shadow:0 4px 12px #dc26263d}.mkai-admin .mk-btn--danger:hover{background:#b91c1c;filter:none}@media(max-width:760px){.mkai-admin .mk-toast-stack{left:14px;right:14px;width:auto;bottom:calc(70px + var(--mk-safe-bottom))}}.mkai-admin .mk-modal-overlay{position:fixed;inset:0;background:#0f172a47;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:var(--mk-z-drawer);padding:16px}.mkai-admin .mk-modal{background:#fffffff0;backdrop-filter:blur(22px) saturate(1.2);-webkit-backdrop-filter:blur(22px) saturate(1.2);border:1px solid rgba(15,23,42,.1);border-radius:16px;padding:18px;width:min(560px,100%);box-shadow:0 20px 50px #0f172a2e;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}.mkai-admin .mk-modal__title{margin:0 0 8px;font-size:1.05rem}.mkai-admin .mobile-tabbar{display:none}.mkai-admin .mk-switch-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.mkai-admin .mk-tabs-inline{display:flex;align-items:center;gap:8px}.mkai-admin .mk-tab-pill{border:1px solid transparent;background:transparent;font:inherit;font-weight:700;cursor:pointer;color:#64748b;padding:7px 12px;border-radius:12px;transition:color .18s ease,background .18s ease,border-color .18s ease,box-shadow .18s ease}.mkai-admin .mk-tab-pill:hover{color:#334155;background:#fff3}.mkai-admin .mk-tab-pill--active{color:var(--glass-pill-active-text);background:var(--glass-pill-active-bg);border-color:var(--glass-pill-active-border);box-shadow:var(--glass-pill-active-shadow)}.mkai-admin .mk-tab-sep{opacity:.35}.mkai-admin .bulk-btn{display:inline-flex;align-items:center;justify-content:center;height:var(--btn-h-sm);min-width:96px;border:1px solid var(--btn-ghost-border);background:var(--btn-ghost-bg);color:#334155;border-radius:10px;padding:0 12px;font:inherit;font-size:12px;font-weight:650;cursor:pointer;transition:background .18s ease,transform .18s ease}.mkai-admin .bulk-btn:hover{background:var(--btn-ghost-hover);transform:translateY(-1px)}.mkai-admin .mk-search-field{margin-top:12px;display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:12px;padding:8px 10px;box-shadow:inset 0 1px 2px #0f172a0a}.mkai-admin .mk-search-field__input{flex:1;border:0;background:transparent;font:inherit;outline:none;color:#1e293b}.mkai-admin .mk-search-field__clear{border:0;background:transparent;cursor:pointer;color:var(--mk-text-muted);display:flex}.mkai-admin .mk-state{padding:28px 12px;text-align:center;color:var(--mk-text-muted)}.mkai-admin .mk-switch-list{display:flex;flex-direction:column;gap:10px}.mkai-admin .broadcast-toolbar__check{display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer}@keyframes mkai-fade-up{0%{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.mkai-admin .page-enter{width:100%}.mkai-admin .main:has(.mkai-page-sessions.is-chat){display:flex;flex-direction:column;padding:0;overflow:hidden}.mkai-admin .main:has(.mkai-page-sessions.is-chat) .page-enter{flex:1;min-height:0;display:flex;flex-direction:column}.mkai-admin .stagger-item{opacity:0;animation:mkai-fade-up .45s cubic-bezier(.22,1,.36,1) forwards}.mkai-admin .stagger-1{animation-delay:.05s}.mkai-admin .stagger-2{animation-delay:.12s}.mkai-admin .stagger-3{animation-delay:.2s}.mkai-admin .stagger-4{animation-delay:.28s}.mkai-admin .stagger-5{animation-delay:.36s}.mkai-admin .fold-panel{background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:16px;box-shadow:var(--panel-shadow);margin-bottom:12px;overflow:hidden}.mkai-admin .fold-panel__summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;cursor:pointer;font-weight:700;color:#0f172a;user-select:none}.mkai-admin .fold-panel__summary::-webkit-details-marker{display:none}.mkai-admin .fold-panel__summary:after{content:"";width:8px;height:8px;border-right:2px solid #64748b;border-bottom:2px solid #64748b;transform:rotate(45deg);transition:transform .22s ease;flex-shrink:0;margin-left:auto}.mkai-admin .fold-panel[open]>.fold-panel__summary:after{transform:rotate(225deg);margin-top:4px}.mkai-admin .fold-panel__meta{font-size:12px;font-weight:600;color:#64748b;margin-left:auto;margin-right:10px}.mkai-admin .fold-panel__body{padding:0 16px 16px;border-top:1px solid rgba(15,23,42,.06);animation:mkai-fade-up .28s cubic-bezier(.22,1,.36,1)}.mkai-admin .sw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}@media(min-width:761px){.mkai-admin .sw-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}}.mkai-admin .sw-skeleton-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}@media(min-width:761px){.mkai-admin .sw-skeleton-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}}.mkai-admin .sw-skeleton{height:92px;border-radius:16px;background:linear-gradient(90deg,#ffffff59,#ffffffa6,#ffffff59);background-size:200% 100%;animation:mkai-shimmer 1.2s ease-in-out infinite}@keyframes mkai-shimmer{0%{background-position:100% 0}to{background-position:-100% 0}}.mkai-admin .sw-card{display:grid;grid-template-columns:48px 1fr auto;align-items:center;gap:10px;padding:12px;border-radius:16px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 2px 10px #0f283c0a;transition:border-color .2s ease,box-shadow .2s ease,transform .18s ease,background .2s ease}.mkai-admin .sw-card:hover{transform:translateY(-1px);box-shadow:0 8px 20px #0f283c14}.mkai-admin .sw-card.is-on{border-color:#14b8a66b;background:linear-gradient(145deg,#fff,#f0fdfa);box-shadow:0 6px 18px #14b8a61f}.mkai-admin .sw-card__avatar{width:48px;height:48px;border-radius:14px;border:0;padding:0;overflow:hidden;background:#e7f1ef;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0f766e;flex-shrink:0}.mkai-admin .sw-card__avatar-img{width:100%;height:100%;object-fit:cover;display:block}.mkai-admin .sw-card__body{min-width:0}.mkai-admin .sw-card__name{font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mkai-admin .sw-card__meta{margin-top:3px;font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mkai-admin .sw-card__toggle{flex-shrink:0}.mkai-admin .mk-modal--enter{animation:mkai-fade-up .28s cubic-bezier(.22,1,.36,1)}@media(max-width:760px){.mkai-admin{flex-direction:column}.mkai-admin .sidebar{display:none}.mkai-admin .mobile-tabbar{display:flex;position:sticky;bottom:0;z-index:20;gap:4px;padding:8px 10px calc(8px + var(--mk-safe-bottom));background:#ffffff6b;backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);border-top:1px solid rgba(255,255,255,.5)}.mkai-admin .mobile-tabbar>button{position:relative;z-index:1;flex:1;border:1px solid transparent;background:transparent;padding:10px 4px;border-radius:12px;font:inherit;font-weight:700;letter-spacing:.06em;cursor:pointer;color:#64748b;transition:color .35s ease}.mkai-admin .mobile-tabbar>button.is-active{background:transparent;color:#0f766e;box-shadow:none}}@media(prefers-reduced-motion:reduce){.mkai-admin .stagger-item,.mkai-admin .fold-panel__body,.mkai-admin .mk-modal--enter{animation:none;opacity:1}.mkai-admin .nav-liquid{transition:none!important}}#page-card-shop .mk-cs-tab-panel{display:none}#page-card-shop .mk-cs-tab-panel.is-active{display:block}.mkai-page-config .mk-cs-tab-panel{display:none}.mkai-page-config .mk-cs-tab-panel.is-active{display:block}.mkai-page-config .glass-card{flex:0 0 auto;min-height:auto;max-height:none;overflow:visible}.mkai-page-config .mk-panel-body{flex:none;min-height:auto;overflow:visible;padding-bottom:max(20px,var(--mk-safe-bottom))}.mkai-page-config .mk-cs-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}@media(max-width:900px){.mkai-page-config .mk-cs-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}.mkai-page-config .mk-cs-stat{background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-width:0;transition:background .18s ease,border-color .18s ease;box-shadow:0 2px 8px #0f28500a}.mkai-page-config .mk-cs-stat:hover{background:var(--glass-bg-hover)}.mkai-page-config .mk-cs-stat__label{font-size:12px;color:#94a3b8;letter-spacing:.02em}.mkai-page-config .mk-cs-stat__value{font-size:1.25rem;font-weight:650;line-height:1.2;word-break:break-all;color:#1e293b}.mkai-page-config .mk-cs-stat--accent .mk-cs-stat__value{color:var(--mk-primary, #3b82f6)}.mkai-page-config .mk-cs-stat--ok .mk-cs-stat__value{color:var(--mk-success, #16a34a)}.mkai-page-config .sc-meter{margin:14px 0 0;padding:14px 16px;border-radius:14px;border:1px solid var(--glass-border-soft);background:var(--glass-bg);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}.mkai-page-config .sc-meter+.sc-meter{margin-top:10px}.mkai-page-config .sc-meter__head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}.mkai-page-config .sc-meter__title{font-size:13px;font-weight:600;color:var(--mk-text, #222)}.mkai-page-config .sc-meter__pct{font-size:13px;font-weight:700;color:var(--mk-primary, #3b82f6);font-variant-numeric:tabular-nums}.mkai-page-config .sc-meter__track{height:10px;border-radius:999px;background:color-mix(in srgb,var(--mk-border, #ddd) 55%,transparent);overflow:hidden}.mkai-page-config .sc-meter__fill{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#22c55e,#3b82f6);transition:width .35s ease}.mkai-page-config .sc-meter__fill--warn{background:linear-gradient(90deg,#f59e0b,#ef4444)}.mkai-page-config .sc-meter__fill--balance{background:linear-gradient(90deg,#6366f1,#3b82f6)}.mkai-page-config .sc-meter__sub{margin-top:8px;font-size:12px;color:var(--mk-muted, #888);line-height:1.45}.mkai-page-config .sc-balance-split{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.mkai-page-config .sc-balance-split__item{padding:10px 12px;border-radius:12px;background:var(--glass-bg-soft);border:1px solid var(--glass-border-soft);backdrop-filter:blur(6px)}.mkai-page-config .sc-balance-split__item span{display:block;font-size:11px;color:var(--mk-muted, #888)}.mkai-page-config .sc-balance-split__item strong{display:block;margin-top:4px;font-size:15px;font-variant-numeric:tabular-nums}.mkai-page-config .sc-profile{margin-bottom:16px;padding:0;border-radius:0;border:none;background:transparent}.mkai-page-config .sc-profile__title{font-size:13px;font-weight:650;margin:0 0 10px;color:#334155}.mkai-page-config .sc-profile__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:8px}@media(max-width:720px){.mkai-page-config .sc-profile__grid{grid-template-columns:1fr}}.mkai-page-config .sc-profile__item{min-width:0;display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:12px;background:var(--glass-bg);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid var(--glass-border-soft);transition:background .18s ease,border-color .18s ease}.mkai-page-config .sc-profile__item:hover{background:var(--glass-bg-hover);border-color:#ffffff73}.mkai-page-config .sc-profile__item--full{grid-column:1 / -1}.mkai-page-config .sc-profile__label{display:block;font-size:12px;font-weight:500;color:#94a3b8;margin-bottom:2px;letter-spacing:.02em}.mkai-page-config .sc-profile__value{display:block;font-size:14px;font-weight:600;color:#1e293b;line-height:1.45;word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap}.mkai-page-config .sc-profile__value--mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:500;font-size:12.5px;color:#334155}.mkai-page-config .sc-profile__badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:650}.mkai-page-config .sc-profile__badge--ok{background:#16a34a29;border:1px solid rgba(22,163,74,.22);color:var(--mk-success, #16a34a)}.mkai-page-config .sc-profile__badge--off{background:#94a3b847;border:1px solid rgba(148,163,184,.25);color:#64748b}.mkai-page-config .sc-profile__hint{margin:10px 0 0;font-size:12px;color:var(--mk-muted, #888);line-height:1.45}.mkai-page-config .sc-ns-banner{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px dashed color-mix(in srgb,var(--mk-primary, #3b82f6) 45%,transparent);background:color-mix(in srgb,var(--mk-primary, #3b82f6) 8%,transparent);font-size:12px;line-height:1.5;color:var(--mk-text, #222)}.mkai-page-config .sc-kb-fold{margin:12px 0 16px;border:1px solid var(--glass-border-soft);border-radius:14px;background:var(--glass-bg);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);overflow:hidden}.mkai-page-config .sc-kb-fold__summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;user-select:none;font-weight:600}.mkai-page-config .sc-kb-fold__summary::-webkit-details-marker{display:none}.mkai-page-config .sc-kb-fold__summary:after{content:"▸";opacity:.55;transition:transform .15s ease;font-size:12px}.mkai-page-config .sc-kb-fold[open]>.sc-kb-fold__summary:after{transform:rotate(90deg)}.mkai-page-config .sc-kb-fold__title{flex:1}.mkai-page-config .sc-kb-fold__meta{font-size:12px;font-weight:500;opacity:.65}.mkai-page-config .sc-kb-fold__body{padding:0 12px 12px;border-top:1px solid rgba(255,255,255,.28)}.mkai-page-config .sc-sticker-gallery-list{display:flex;flex-direction:column;gap:10px;margin-top:10px}.mkai-page-config .sc-sticker-card{border:1px solid var(--glass-border-soft);border-radius:12px;padding:12px;background:var(--glass-bg-soft);backdrop-filter:blur(6px)}.mkai-page-config .sc-sticker-card__head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}.mkai-page-config .sc-sticker-card__title{font-weight:650;margin:0 0 4px}.mkai-page-config .sc-sticker-card__desc{margin:0;font-size:12px;opacity:.72;line-height:1.45}.mkai-page-config .sc-sticker-progress{margin-top:10px;display:block}.mkai-page-config .sc-sticker-progress__track{height:8px;border-radius:999px;background:#0f172a14;overflow:hidden}.mkai-page-config .sc-sticker-progress__fill{height:100%;width:0%;background:linear-gradient(90deg,#14b8a6,#22c55e);transition:width .2s ease}.mkai-page-config .sc-sticker-progress__meta{margin-top:6px;font-size:12px;opacity:.78;line-height:1.4}.mkai-page-config .sc-kb-list{display:flex;flex-direction:column;gap:0;margin-top:12px;position:relative;padding-left:18px}.mkai-page-config .sc-kb-list:before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;border-radius:2px;background:linear-gradient(180deg,color-mix(in srgb,var(--mk-primary, #3b82f6) 70%,transparent),color-mix(in srgb,var(--mk-border, #ddd) 80%,transparent))}.mkai-page-config .sc-kb-row{display:flex;flex-direction:row;align-items:stretch;gap:12px;padding:12px 14px;margin:8px 0;border-radius:12px;border:1px solid var(--glass-border-soft);background:var(--glass-bg);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);min-width:0;position:relative;transition:background .18s ease}.mkai-page-config .sc-kb-row:hover{background:var(--glass-bg-hover)}.mkai-page-config .sc-kb-row:before{content:"";position:absolute;left:-16px;top:50%;width:12px;height:2px;background:color-mix(in srgb,var(--mk-primary, #3b82f6) 55%,var(--mk-border, #ddd))}.mkai-page-config .sc-kb-row:after{content:"";position:absolute;left:-20px;top:calc(50% - 4px);width:8px;height:8px;border-radius:50%;border:2px solid color-mix(in srgb,var(--mk-primary, #3b82f6) 75%,transparent);background:#ffffff8c;box-sizing:border-box}.mkai-page-config .sc-kb-row.is-builtin{border-color:#60a5fa66;background:#3b82f61a}.mkai-page-config .sc-kb-row.is-builtin:after{background:#3b82f6d9;border-color:#3b82f6e6}.mkai-page-config .sc-kb-row.is-off{opacity:.72}.mkai-page-config .sc-kb-row.is-off:after{background:color-mix(in srgb,var(--mk-border, #ddd) 80%,#fff);border-color:var(--mk-border, #ddd)}.mkai-page-config .sc-kb-row__body{flex:1;min-width:0;cursor:pointer}.mkai-page-config .sc-kb-row.is-builtin .sc-kb-row__body{cursor:default}.mkai-page-config .sc-kb-row__meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 6px}.mkai-page-config .sc-kb-row__badge{display:inline-flex;align-items:center;font-size:11px;font-weight:650;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid color-mix(in srgb,var(--mk-primary, #3b82f6) 40%,transparent);color:color-mix(in srgb,var(--mk-primary, #3b82f6) 85%,var(--mk-text, #222));background:color-mix(in srgb,var(--mk-primary, #3b82f6) 12%,transparent)}.mkai-page-config .sc-kb-row__badge--custom{border-color:color-mix(in srgb,var(--mk-border, #ddd) 90%,transparent);color:color-mix(in srgb,var(--mk-text, #222) 70%,transparent);background:color-mix(in srgb,var(--mk-border, #ddd) 18%,transparent)}.mkai-page-config .sc-kb-row__title{font-size:14px;font-weight:650;color:var(--mk-text, #222);margin:0;word-break:break-word}.mkai-page-config .sc-kb-row__content{font-size:12px;line-height:1.45;color:color-mix(in srgb,var(--mk-text, #222) 62%,transparent);margin-top:6px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-height:4.5em;overflow:hidden}.mkai-page-config .sc-kb-row__side{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:6px;flex-shrink:0}.mkai-page-config .sc-kb-tree-hint{margin:0 0 4px;font-size:12px;line-height:1.5;color:color-mix(in srgb,var(--mk-text, #222) 65%,transparent)}.mkai-page-config .sc-kb-cap{position:relative;width:42px;height:24px;border:0;border-radius:999px;padding:0;cursor:pointer;background:color-mix(in srgb,var(--mk-border, #ddd) 80%,#999);flex-shrink:0}.mkai-page-config .sc-kb-cap.is-on{background:color-mix(in srgb,var(--mk-primary, #3b82f6) 85%,#2563eb)}.mkai-page-config .sc-kb-cap__knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px #0000002e}.mkai-page-config .sc-kb-cap.is-on .sc-kb-cap__knob{transform:translate(18px)}.mkai-page-config .sc-kb-cap__label{font-size:12px;color:color-mix(in srgb,var(--mk-text, #222) 70%,transparent)}.sc-kb-cap{position:relative;width:46px;height:26px;border-radius:999px;border:none;padding:0;cursor:pointer;background:color-mix(in srgb,#94a3b8 45%,#e2e8f0);transition:background .2s ease;flex-shrink:0;display:inline-block;vertical-align:middle}html.dark .sc-kb-cap{background:color-mix(in srgb,#64748b 55%,#1e293b)}.sc-kb-cap.is-on{background:color-mix(in srgb,var(--mk-success, #16a34a) 88%,#86efac)}.sc-kb-cap__knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0000002e;transition:transform .2s ease;pointer-events:none}.sc-kb-cap.is-on .sc-kb-cap__knob{transform:translate(20px)}.sc-kb-cap__label{font-size:11px;color:var(--mk-muted, #888);flex-shrink:0;min-width:2em}.mkai-ai-only-modal .sc-ai-only-row{display:flex;align-items:center;gap:12px;padding:14px 12px;border-radius:12px;border:1px solid var(--mk-border);background:color-mix(in srgb,var(--mk-surface-muted) 50%,var(--mk-surface))}.mkai-ai-only-modal .sc-ai-only-row__text{flex:1;min-width:0}.mkai-ai-only-modal .sc-ai-only-row__title{display:block;font-size:14px;font-weight:650;color:var(--mk-text)}.mkai-ai-only-modal .sc-ai-only-row__desc{display:block;margin-top:4px;font-size:12px;line-height:1.45;color:var(--mk-text-muted)}.mkai-ai-only-modal .sc-ai-only-rounds{margin-top:14px;padding-top:14px;border-top:1px solid color-mix(in srgb,var(--mk-border, #334) 80%,transparent)}.mkai-ai-only-modal .sc-ai-only-rounds .mk-label{display:block;margin-bottom:6px}.mkai-ai-only-modal .sc-ai-only-rounds .mk-hint{margin:6px 0 0;font-size:12px;line-height:1.45}.mkai-ai-only-modal .sc-ai-only-row__switch{display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0}.mkai-page-switch .mk-switch-list{gap:10px}.mkai-page-switch .mk-entity-card{position:relative;border-radius:14px;padding:13px 14px;min-height:88px;overflow:hidden;background:var(--glass-bg);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--glass-border-soft);transition:border-color .22s ease,box-shadow .22s ease,background .22s ease,transform .18s ease}.mkai-page-switch .mk-entity-card__name-row{display:flex;align-items:center;gap:8px;min-width:0}.mkai-page-switch .mk-entity-card__name{min-width:0;flex:1}.mkai-page-switch .mk-entity-card.is-enabled.is-group{border-color:#38bdf86b;background:linear-gradient(135deg,#0ea5e929,#ffffff2e);box-shadow:0 0 0 1px #38bdf829,0 8px 22px #0ea5e91f}.mkai-page-switch .mk-entity-card.is-enabled.is-group:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:999px;background:linear-gradient(180deg,#7dd3fc,#0284c7)}.mkai-page-switch .mk-entity-card.is-enabled.is-group .mk-entity-card__avatar{box-shadow:0 0 0 2px color-mix(in srgb,#38bdf8 45%,transparent)}.mkai-page-switch .mk-entity-card.is-enabled.is-group .mk-entity-card__name{color:#bae6fd}.mkai-page-switch .mk-entity-card.is-enabled.is-friend{border-color:#f472b666;background:linear-gradient(135deg,#ec489924,#ffffff2e);box-shadow:0 0 0 1px #f472b624,0 8px 22px #db27771a}.mkai-page-switch .mk-entity-card.is-enabled.is-friend:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:999px;background:linear-gradient(180deg,#f9a8d4,#db2777)}.mkai-page-switch .mk-entity-card.is-enabled.is-friend .mk-entity-card__avatar{box-shadow:0 0 0 2px color-mix(in srgb,#f472b6 42%,transparent)}.mkai-page-switch .mk-entity-card.is-enabled.is-friend .mk-entity-card__name{color:#fbcfe8}html:not(.dark) .mkai-page-switch .mk-entity-card.is-enabled.is-group .mk-entity-card__name{color:#0369a1}html:not(.dark) .mkai-page-switch .mk-entity-card.is-enabled.is-friend .mk-entity-card__name{color:#be185d}@media(hover:hover){.mkai-page-switch .mk-entity-card.is-enabled.is-group:hover{transform:translateY(-1px);box-shadow:0 0 0 1px color-mix(in srgb,#38bdf8 22%,transparent),0 10px 26px color-mix(in srgb,#0ea5e9 18%,transparent)}.mkai-page-switch .mk-entity-card.is-enabled.is-friend:hover{transform:translateY(-1px);box-shadow:0 0 0 1px color-mix(in srgb,#f472b6 20%,transparent),0 10px 26px color-mix(in srgb,#db2777 16%,transparent)}}.mkai-page-config .sc-kb-hint{margin:0 0 10px;font-size:12px;color:var(--mk-muted, #888);line-height:1.45}.mkai-page-config .sc-param-box{margin:0 0 14px;padding:14px 12px 16px;border:1px solid rgba(15,23,42,.1);border-radius:14px;background:#f8fafc;text-align:center}.mkai-page-config .sc-param-box__title{display:block;margin:0 0 12px;font-weight:600;text-align:center}.mkai-page-config .sc-param-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px 14px;width:100%;align-items:start}.mkai-page-config .sc-param-grid .mk-form-group{margin:0;width:100%;min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px}.mkai-page-config .sc-param-grid .mk-label{margin:0;width:100%;text-align:center;line-height:1.3}.mkai-page-config .sc-param-grid .mk-input{width:100%;text-align:center;box-sizing:border-box}@media(max-width:900px){.mkai-page-config .sc-param-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:520px){.mkai-page-config .sc-param-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}.mkai-page-config .sc-provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}@media(max-width:900px){.mkai-page-config .sc-provider-grid{grid-template-columns:1fr}}.mkai-page-config .sc-provider-card{padding:14px 16px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;opacity:1;transition:border-color .15s,box-shadow .15s,background .15s;box-shadow:0 2px 8px #0f28500a}.mkai-page-config .sc-provider-card.is-configured{border-color:#14b8a666;background:#f0fdfa;box-shadow:0 0 0 1px #14b8a614}.mkai-page-config .sc-provider-card--warn{border-color:color-mix(in srgb,#c2410c 45%,transparent)}.mkai-page-config .sc-provider-card__top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}.mkai-page-config .sc-provider-card__badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#94a3b847;color:#64748b}.mkai-page-config .sc-provider-card.is-configured .sc-provider-card__badge{background:color-mix(in srgb,var(--mk-success, #16a34a) 18%,transparent);color:var(--mk-success, #16a34a)}.mkai-page-config .sc-provider-card__links{margin:0 0 8px;font-size:12px;line-height:1.45;word-break:break-all}.mkai-page-config .sc-provider-card__warn{margin:0 0 8px;font-size:12px;line-height:1.45;color:#c2410c}.mkai-page-config .sc-provider-card__status{font-size:12px;margin-left:4px}.mkai-page-config .sc-provider-card__status.is-ok{color:var(--mk-success, #16a34a)}.mkai-page-config .sc-provider-card__status.is-err{color:#dc2626}.mkai-admin .mk-entity-card{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:14px;position:relative;overflow:hidden;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 2px 8px #0f28500a}.mkai-admin .mk-entity-card__main{display:flex;align-items:center;gap:12px;min-width:0;flex:1}.mkai-admin .mk-entity-card__avatar{width:44px;height:44px;border-radius:12px;border:0;padding:0;overflow:hidden;background:#ffffff47;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700;color:#64748b;flex-shrink:0}.mkai-admin .mk-entity-card__avatar-img{width:100%;height:100%;object-fit:cover;display:block}.mkai-admin .mk-entity-card__text{min-width:0}.mkai-admin .mk-entity-card__name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1e293b}.mkai-admin .mk-entity-card__id{font-size:12px;color:#64748b;margin-top:2px}.mkai-admin .mk-entity-card__toggle{flex-shrink:0}.mkai-admin .toggle-switch{position:relative;display:inline-block;width:46px;height:26px}.mkai-admin .toggle-switch input{opacity:0;width:0;height:0}.mkai-admin .toggle-slider{position:absolute;cursor:pointer;inset:0;background:#64748b47;border-radius:999px;transition:.2s;border:1px solid rgba(255,255,255,.35)}.mkai-admin .toggle-slider:before{content:"";position:absolute;height:20px;width:20px;left:3px;top:2px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px #0000002e}.mkai-admin .toggle-switch input:checked+.toggle-slider{background:#14b8a6cc;border-color:#2dd4bf8c}.mkai-admin .toggle-switch input:checked+.toggle-slider:before{transform:translate(20px)}.mkai-admin .sc-kb-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.1);margin-bottom:8px;transition:background .18s ease,border-color .18s ease}.mkai-admin .sc-kb-row:hover{background:#f8fafc;border-color:#0f172a29}.mkai-admin .sc-kb-row__main{min-width:0;flex:1}.mkai-admin .sc-sticker-card{padding:12px 14px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.1);margin-bottom:8px}.mkai-admin .sc-sticker-card__top{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;align-items:center}.mkai-admin .sc-sticker-progress{margin:10px 0;display:block}.mkai-admin .sc-sticker-progress__track{height:8px;border-radius:999px;background:#0f172a14;overflow:hidden}.mkai-admin .sc-sticker-progress__fill{height:100%;width:0%;background:linear-gradient(90deg,#14b8a6,#22c55e);transition:width .2s ease}.mkai-admin .sc-sticker-progress__meta{margin:6px 0 0;font-size:12px;color:#64748b;line-height:1.4}.mkai-admin .sc-sticker-card__source{margin:6px 0 0;font-size:12px;color:#94a3b8}.mkai-admin .sc-source-modal{width:min(480px,100%)}.mkai-admin .sc-source-list{display:flex;flex-direction:column;gap:10px;margin-bottom:4px}.mkai-admin .sc-source-opt{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:12px 14px;border-radius:12px;border:1px solid rgba(15,23,42,.12);background:#fff;font:inherit;color:inherit;cursor:pointer;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease}.mkai-admin .sc-source-opt:hover{background:#f8fafc;border-color:#0f172a33}.mkai-admin .sc-source-opt.is-active{border-color:#14b8a6;background:#14b8a60f;box-shadow:0 0 0 1px #14b8a659 inset}.mkai-admin .sc-source-opt__radio{flex:0 0 auto;width:16px;height:16px;margin-top:2px;border-radius:50%;border:2px solid rgba(15,23,42,.25);background:#fff;position:relative}.mkai-admin .sc-source-opt.is-active .sc-source-opt__radio{border-color:#14b8a6}.mkai-admin .sc-source-opt.is-active .sc-source-opt__radio:after{content:"";position:absolute;inset:3px;border-radius:50%;background:#14b8a6}.mkai-admin .sc-source-opt__body{display:flex;flex-direction:column;gap:3px;min-width:0}.mkai-admin .sc-source-opt__label{font-size:13px;font-weight:650}.mkai-admin .sc-source-opt__desc{font-size:12px;color:#64748b;line-height:1.45}@media(prefers-reduced-transparency:reduce){.mkai-admin .sc-source-opt{background:#fff}}@media(max-width:760px){.mkai-admin .sc-kb-row{flex-direction:column;align-items:stretch;gap:10px}.mkai-admin .sc-kb-row__actions{display:grid!important;grid-template-columns:1fr 1fr auto;gap:8px;width:100%;align-items:center}.mkai-admin .sc-kb-row__actions .mk-btn{width:100%}.mkai-admin .sc-kb-row__actions .toggle-switch{justify-self:end}}.mkai-admin .sc-kb-cap{width:46px;height:26px;border:1px solid rgba(255,255,255,.35);border-radius:999px;background:#64748b47;position:relative;cursor:pointer;padding:0}.mkai-admin .sc-kb-cap.is-on{background:#14b8a6cc;border-color:#2dd4bf8c}.mkai-admin .sc-kb-cap__knob{position:absolute;top:2px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px #0000002e}.mkai-admin .sc-kb-cap.is-on .sc-kb-cap__knob{transform:translate(20px)}.mkai-admin .sc-kb-cap__label{font-size:12px;font-weight:650;margin-left:6px;color:#475569}.mkai-admin .mkai-page-sessions{display:flex;flex-direction:column;min-height:0;width:100%}.mkai-admin .mkai-page-sessions.is-chat{flex:1;height:100%;min-height:0}.mkai-admin .im-shell{display:flex;flex-direction:column;min-height:0;flex:1;width:100%}.mkai-admin .im-shell-page{min-height:min(72vh,720px);border:1px solid rgba(255,255,255,.42);border-radius:16px;overflow:hidden;background:#ffffff24;backdrop-filter:blur(14px) saturate(1.15);-webkit-backdrop-filter:blur(14px) saturate(1.15);box-shadow:0 8px 28px #94a3b81f}.mkai-admin .mkai-page-sessions.is-chat .im-shell-page{min-height:0;flex:1;border-radius:0;border:0;box-shadow:none}.mkai-admin .im-list-full,.mkai-admin .im-pane-full{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}.mkai-admin .im-list-head{display:flex;gap:8px;padding:10px;border-bottom:1px solid rgba(255,255,255,.25);background:#ffffff14}.mkai-admin .im-list-head input{flex:1;min-width:0;border:1px solid rgba(255,255,255,.4);background:#fff3;backdrop-filter:blur(6px);border-radius:12px;padding:8px 10px;font:inherit;font-size:13px;color:#334155}.mkai-admin .im-list-head input::placeholder{color:#94a3b8}.mkai-admin .im-sessions{flex:1;overflow:auto;min-height:0;padding:10px;display:flex;flex-direction:column;gap:10px}.mkai-admin .im-session{display:grid;grid-template-columns:44px 1fr;gap:10px;align-items:center;padding:12px;cursor:pointer;border-radius:14px;border:1.5px solid rgba(148,163,184,.45);background:#ffffff2e;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:0 4px 14px #94a3b81a;transition:background .2s,border-color .2s,box-shadow .2s;user-select:none;-webkit-user-select:none;touch-action:manipulation}.mkai-admin .im-session.is-active{border-color:#16a34ab8;box-shadow:0 4px 14px #16a34a1f}.mkai-admin .im-session.is-stale{border-color:#94a3b8b3;opacity:.92}.mkai-admin .im-session:hover{background:#ffffff47;box-shadow:0 8px 20px #94a3b829}.mkai-admin .im-session.is-active:hover{border-color:#16a34ae6}.mkai-admin .im-session.is-stale:hover{border-color:#64748bd9}.mkai-admin .im-session-body{min-width:0;display:flex;flex-direction:column;gap:4px}.mkai-admin .im-session-top{display:flex;align-items:center;gap:8px;min-width:0}.mkai-admin .im-session-title{flex:1;min-width:0;margin:0;font-size:13px;font-weight:700;color:#0f766e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .im-session-bottom{display:flex;align-items:center;gap:8px;min-width:0}.mkai-admin .im-session-preview{flex:1;min-width:0;font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .im-type,.mkai-admin .im-pane-type{flex-shrink:0;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;border:1px solid transparent;letter-spacing:.02em}.mkai-admin .im-type.group,.mkai-admin .im-pane-type.group{background:#bae6fdbf;border-color:#38bdf859;color:#0369a1}.mkai-admin .im-type.private,.mkai-admin .im-pane-type.private{background:#fecdd3bf;border-color:#fb718559;color:#be123c}.mkai-admin .im-avatar{width:44px;height:44px;border-radius:999px;display:grid;place-items:center;font-size:15px;font-weight:800;color:#0f766e;background:#14b8a629;border:1px solid rgba(45,212,191,.35);flex-shrink:0;user-select:none}.mkai-admin .im-avatar.out{color:#fff;background:#14b8a6d9;border-color:#ffffff59}.mkai-admin .im-msg .im-avatar{width:36px;height:36px;font-size:13px}.mkai-admin .im-pane{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;background:#ffffff1f}.mkai-admin .im-pane-head{position:sticky;top:0;z-index:6;flex-shrink:0;min-height:56px;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid rgba(255,255,255,.3);background:#ffffff1f;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}.mkai-admin .im-pane-title{font-weight:700;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .im-pane-sub{font-size:12px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .im-back{flex-shrink:0;border:1px solid rgba(255,255,255,.4);background:#ffffff38;backdrop-filter:blur(6px);border-radius:10px;padding:7px 12px;font:inherit;font-size:13px;font-weight:600;color:#0f766e;cursor:pointer;transition:background .15s,transform .15s}.mkai-admin .im-back:hover{background:#ffffff61;transform:translate(-1px)}.mkai-admin .im-messages{flex:1;min-height:0;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px;background:transparent}.mkai-admin .im-empty{margin:auto;padding:12px 20px;color:#94a3b8;font-size:13px;text-align:center;background:#ffffff26;border:1px solid rgba(255,255,255,.25);border-radius:12px;backdrop-filter:blur(6px)}.mkai-admin .im-sys{align-self:center;max-width:86%;padding:6px 12px;border-radius:999px;font-size:12px;color:#64748b;background:#ffffff38;border:1px solid rgba(255,255,255,.28)}.mkai-admin .im-msg{display:grid;grid-template-columns:36px 1fr;gap:10px;max-width:78%;align-self:flex-start}.mkai-admin .im-msg.out{grid-template-columns:1fr 36px;align-self:flex-end}.mkai-admin .im-msg.out .im-avatar{order:2}.mkai-admin .im-msg.out .im-msg-body{order:1;text-align:right}.mkai-admin .im-msg-head{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;margin-bottom:4px}.mkai-admin .im-msg.out .im-msg-head{justify-content:flex-end}.mkai-admin .im-msg-name{font-size:13px;font-weight:600;color:#475569}.mkai-admin .im-msg-role{font-size:10px;font-weight:600;color:#64748b;padding:1px 6px;border-radius:999px;background:#94a3b829}.mkai-admin .im-msg-time{font-size:10px;color:#94a3b8}.mkai-admin .im-msg-title{font-size:10px;font-weight:600;color:#0f766e;padding:1px 6px;border-radius:999px;background:#0d948824;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .im-msg-meta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 4px;max-width:100%}.mkai-admin .im-msg.out .im-msg-meta{justify-content:flex-end}.mkai-admin .im-msg-meta__chip{display:inline-block;max-width:100%;padding:2px 8px;border-radius:8px;font-size:11px;line-height:1.4;overflow-wrap:anywhere;word-break:break-word}.mkai-admin .im-msg-meta__chip--reply{color:#475569;background:#94a3b824;border:1px solid rgba(148,163,184,.22)}.mkai-admin .im-msg-meta__chip--at{color:#0f766e;background:#14b8a61a;border:1px solid rgba(20,184,166,.22)}.mkai-admin .im-bubble{margin-top:0;display:inline-block;max-width:100%;background:#ffffff4d;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.5);border-radius:1rem;border-top-left-radius:4px;padding:10px 14px;font-size:13px;line-height:1.55;text-align:left;color:#1e293b;overflow-wrap:anywhere;word-break:break-word;box-shadow:0 4px 14px #94a3b81f;white-space:pre-wrap}.mkai-admin .im-msg.out .im-bubble{background:#14b8a6cc;border:1px solid rgba(255,255,255,.3);border-radius:1rem;border-top-right-radius:4px;color:#fff;box-shadow:0 10px 24px #14b8a638}.mkai-admin .im-bubble--meta{opacity:.92;font-size:12px}.mkai-admin .im-bubble-text{display:block}.mkai-admin .im-bubble--voice .im-bubble-text{display:flex;align-items:flex-start;gap:6px}.mkai-admin .im-bubble--voice .im-bubble-text:before{content:"🔊";flex-shrink:0;font-size:13px;line-height:inherit;opacity:.85}.mkai-admin .im-bubble-eyes{margin-top:8px;padding-top:8px;border-top:1px dashed rgba(100,116,139,.35);font-size:11px;line-height:1.45;color:#64748b}.mkai-admin .im-msg.out .im-bubble-eyes{border-top-color:#ffffff59;color:#ffffffe0}.mkai-admin .im-bubble-eyes__line+.im-bubble-eyes__line{margin-top:4px}.mkai-admin .im-scroll-anchor{height:1px;width:100%;flex-shrink:0}@media(max-width:860px){.mkai-admin .mkai-page-sessions.is-chat .im-shell-page{min-height:calc(100dvh - 64px)}.mkai-admin .im-msg{max-width:92%}.mkai-admin .im-msg-title{max-width:88px}}.mkai-admin.mkai-cursor-on,.mkai-admin.mkai-cursor-on *{cursor:none!important}.mkai-admin .mkai-cursor{position:fixed;top:0;left:0;width:32px;height:32px;z-index:2147483000;pointer-events:none!important;will-change:transform,opacity;display:grid;place-items:center;transition:opacity .18s ease}.mkai-admin .mkai-cursor__ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(15,118,110,.85);background:#14b8a600;box-shadow:0 0 10px #14b8a652;transition:transform .16s ease,border-color .16s ease,background-color .16s ease}.mkai-admin .mkai-cursor__dot{position:absolute;width:6px;height:6px;border-radius:50%;background:#0f766ef2;transition:transform .16s ease,opacity .16s ease}.mkai-admin .mkai-cursor.is-active .mkai-cursor__ring{transform:scale(1.55);border-color:#14b8a6f2;background:#14b8a61f}.mkai-admin .mkai-cursor.is-active .mkai-cursor__dot{transform:scale(.4);opacity:.5}.mkai-admin .mkai-cursor.is-press .mkai-cursor__ring{transform:scale(.82)}@media(hover:none),(pointer:coarse){.mkai-admin .mkai-cursor{display:none!important}.mkai-admin.mkai-cursor-on,.mkai-admin.mkai-cursor-on *{cursor:auto!important}}@media(prefers-reduced-motion:reduce){.mkai-admin .mkai-cursor__ring,.mkai-admin .mkai-cursor__dot{transition:none}}.mkai-admin .mkai-page-overview{width:100%;max-width:none}.mkai-admin .ov-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;align-items:start}.mkai-admin .mkai-page-overview .mk-panel-head{padding:10px 16px 6px;flex-shrink:0}.mkai-admin .mkai-page-overview .mk-panel-body{padding:10px 16px 14px}.mkai-admin .ov-card{min-height:0;height:auto;display:flex;flex-direction:column}.mkai-admin .ov-card>.mk-panel-body{flex:0 0 auto}.mkai-admin .ov-card--wide,.mkai-admin .ov-card--span2{grid-column:span 2}.mkai-admin .ov-card--full{grid-column:1 / -1}.mkai-admin .ov-card--kpi-row{min-height:0}.mkai-admin .ov-card--kpi-row .mk-panel-body{padding:12px 16px}.mkai-admin .ov-kpi--footer .ov-kpi__cell{align-items:center;text-align:center}.mkai-admin .ov-card__title{margin:0;font-size:.92rem;font-weight:700;color:var(--mk-text);letter-spacing:.01em;line-height:1.3}.mkai-admin .ov-card__chart{display:flex;align-items:center;justify-content:flex-start;gap:12px;flex-wrap:wrap;min-height:0}.mkai-admin .ov-card:not(.ov-card--span2):not(.ov-card--wide) .ov-card__chart{justify-content:center}.mkai-admin .ov-kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.mkai-admin .ov-kpi__cell{display:flex;flex-direction:column;gap:4px;align-items:flex-start}.mkai-admin .ov-kpi__num{font-size:1.6rem;font-weight:780;line-height:1.1;color:var(--mk-text);font-variant-numeric:tabular-nums}.mkai-admin .ov-kpi__num--sm{font-size:1.15rem}.mkai-admin .ov-kpi__label{font-size:12px;color:var(--mk-text-muted)}.mkai-admin .ov-inline-kpi{display:grid;grid-template-columns:repeat(2,auto);gap:8px 20px}.mkai-admin .ov-inline-kpi--even{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 10px;width:100%;max-width:360px}.mkai-admin .ov-inline-kpi--even .ov-kpi__cell{align-items:center;text-align:center}.mkai-admin .ov-usage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px}.mkai-admin .ov-usage-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:10px;min-width:0;padding:2px 6px}.mkai-admin .ov-usage-col+.ov-usage-col{border-left:1px solid rgba(15,23,42,.08)}.mkai-admin .ov-usage-col__label{font-size:11px;font-weight:650;color:var(--mk-text-muted);letter-spacing:.02em;text-align:center;width:100%}.mkai-admin .ov-usage-donut{display:flex;align-items:center;justify-content:center;width:100%;min-width:0;max-width:calc(var(--mk-donut-px, 132) * 1px);margin-inline:auto}.mkai-admin .mk-chart--donut{--mk-donut-px: 132;flex-shrink:0}.mkai-admin .mk-chart--donut .mk-chart__num{font-size:clamp(11px,calc(var(--mk-donut-px) * .152px),22px)}.mkai-admin .mk-chart--donut .mk-chart__sub{font-size:clamp(9px,calc(var(--mk-donut-px) * .085px),13px)}.mkai-admin .ov-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--mk-text-muted)}.mkai-admin .ov-legend li{display:flex;align-items:center;gap:7px}.mkai-admin .ov-legend i{width:10px;height:10px;border-radius:3px;flex-shrink:0}.mkai-admin .ov-bignum{font-size:1.5rem;font-weight:760;text-align:center;color:var(--mk-text)}.mkai-admin .ov-bignum--warn{color:var(--mk-warn)}.mkai-admin .ov-bignum--muted{color:var(--mk-muted)}.mkai-admin .ov-caps{margin-top:14px}.mkai-admin .ov-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:0}.mkai-admin .ov-meta>div{display:flex;flex-direction:column;gap:3px;min-width:0}.mkai-admin .ov-meta dt{font-size:11px;color:var(--mk-text-muted)}.mkai-admin .ov-meta dd{margin:0;font-size:.92rem;font-weight:650;color:var(--mk-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .mk-chart{display:block}.mkai-admin .mk-chart--donut-interactive .mk-chart__seg{cursor:pointer;transition:opacity var(--mk-dur-fast, .16s) ease,filter var(--mk-dur-fast, .16s) ease;outline:none}.mkai-admin .mk-chart--donut-interactive .mk-chart__seg.is-dim{opacity:.38}.mkai-admin .mk-chart--donut-interactive .mk-chart__seg.is-active{opacity:1;filter:brightness(1.08)}.mkai-admin .mk-chart--donut-interactive .mk-chart__seg:focus-visible{filter:brightness(1.12)}.mkai-admin .mk-chart__num{font-size:20px;font-weight:780;fill:var(--mk-text);font-variant-numeric:tabular-nums}.mkai-admin .mk-chart__sub{font-size:11px;fill:var(--mk-text-muted)}.mkai-admin .mk-chart--gauge{overflow:visible}.mkai-admin .mk-minibar{display:flex;flex-direction:column;gap:10px}.mkai-admin .mk-minibar__row{display:grid;grid-template-columns:56px 1fr auto;align-items:center;gap:10px}.mkai-admin .mk-minibar__label{font-size:12px;color:var(--mk-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkai-admin .mk-minibar__track{height:8px;border-radius:999px;background:#94a3b838;overflow:hidden}.mkai-admin .mk-minibar__fill{display:block;height:100%;border-radius:999px;transition:width var(--mk-dur-base, .24s) var(--mk-ease-out, ease)}.mkai-admin .mk-minibar__val{font-size:12px;font-weight:650;color:var(--mk-text);font-variant-numeric:tabular-nums}.mkai-admin .ov-skeleton{position:relative;overflow:hidden;min-height:96px;background-color:#94a3b81f;background-image:linear-gradient(90deg,#94a3b81f 25%,#ffffff59 37%,#94a3b81f 63%);background-size:300% 100%;animation:ov-shimmer-bg 1.3s ease-in-out infinite}@keyframes ov-shimmer-bg{0%{background-position:100% 0}to{background-position:0 0}}.mkai-admin.is-desktop .ov-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.mkai-admin.is-desktop .ov-card--full .ov-meta{grid-template-columns:repeat(3,1fr)}.mkai-admin.is-mobile .ov-grid{grid-template-columns:1fr;gap:12px}.mkai-admin.is-mobile .mkai-page-overview .mk-panel-head{padding:8px 14px 4px}.mkai-admin.is-mobile .mkai-page-overview .mk-panel-body{padding:8px 14px 12px}.mkai-admin.is-mobile .ov-card__chart{gap:10px}.mkai-admin.is-mobile .ov-usage-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}.mkai-admin.is-mobile .ov-usage-col+.ov-usage-col{border-left:1px solid rgba(15,23,42,.08);border-top:0;padding-top:0}.mkai-admin.is-mobile .ov-usage-col__label{font-size:10px}.mkai-admin.is-mobile .ov-usage-col{gap:6px;padding:0 2px}.mkai-admin.is-mobile .ov-inline-kpi--even{grid-template-columns:repeat(2,minmax(0,1fr));max-width:none}.mkai-admin.is-mobile .ov-card--wide,.mkai-admin.is-mobile .ov-card--span2,.mkai-admin.is-mobile .ov-card--full{grid-column:span 1}.mkai-admin.is-mobile .ov-kpi{grid-template-columns:repeat(2,1fr);gap:12px}.mkai-admin.is-mobile .ov-kpi--footer .ov-kpi__cell{align-items:flex-start;text-align:left}@media(prefers-reduced-motion:reduce){.mkai-admin .ov-skeleton{animation:none}.mkai-admin .mk-minibar__fill{transition:none}}.mkai-admin .sc-rot-limit{width:92px;flex-shrink:0;text-align:center}.mkai-admin .sc-rot-seg{margin:14px 0 10px}.mkai-admin .sc-rot-seg .seg__btn{min-width:0;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;line-height:38px;text-align:center}.mkai-admin .sc-rot-notes{display:flex;flex-direction:column;gap:4px}.mkai-admin .sc-rot-notes__line{margin:0;line-height:1.5}@media(max-width:760px){.mkai-admin .sc-rot-limit{width:76px}.mkai-admin .sc-rot-seg{padding:4px;gap:2px}.mkai-admin .sc-rot-seg .seg__btn{padding:0 2px;font-size:13px;letter-spacing:-.2px}}@media(max-width:380px){.mkai-admin .sc-rot-seg .seg__btn{font-size:12px}}@media(prefers-reduced-transparency:reduce){.mkai-admin .glass-card,.mkai-admin .panel,.mkai-admin .fold-panel,.mkai-admin .sidebar,.mkai-admin .mk-nav__liquid,.mkai-admin .mk-toast,.mkai-admin .mk-modal,.mkai-admin .mobile-tabbar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:#fffffff0!important}.mkai-admin .mk-modal-overlay{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:#0f172a6b!important}}@media(prefers-reduced-data:reduce){.mkai-admin .glass-card,.mkai-admin .panel,.mkai-admin .fold-panel,.mkai-admin .sidebar,.mkai-admin .mk-toast,.mkai-admin .mk-modal,.mkai-admin .mobile-tabbar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:#fffffff0!important}}@media(max-device-memory:4){.mkai-admin .glass-card,.mkai-admin .panel,.mkai-admin .fold-panel,.mkai-admin .sw-card,.mkai-admin .mk-entity-card{backdrop-filter:none;-webkit-backdrop-filter:none;background:#ffffffe6}}@media(max-hardware-concurrency:4){.mkai-admin .glass-card,.mkai-admin .panel,.mkai-admin .fold-panel,.mkai-admin .sw-card,.mkai-admin .mk-entity-card{backdrop-filter:none;-webkit-backdrop-filter:none;background:#ffffffe6}}', Xt = ".mkai-admin{--mk-brand-50: #f0fdfa;--mk-brand-100: #ccfbf1;--mk-brand-200: #99f6e4;--mk-brand-300: #5eead4;--mk-brand-400: #2dd4bf;--mk-brand-500: #14b8a6;--mk-brand-600: #0d9488;--mk-brand-700: #0f766e;--mk-brand-800: #115e59;--mk-brand-900: #134e4a;--mk-accent: var(--mk-brand-700);--mk-accent-strong: var(--mk-brand-800);--mk-accent-soft: var(--mk-brand-100);--mk-accent-ring: rgba(20, 184, 166, .22);--mk-on-accent: #ffffff;--mk-info: #0284c7;--mk-warn: #d97706;--mk-danger: #dc2626;--mk-radius-xs: 8px;--mk-radius-sm: 10px;--mk-radius-md: 14px;--mk-radius-lg: 18px;--mk-radius-xl: 24px;--mk-radius-2xl: 30px;--mk-radius-pill: 999px;--mk-elev-1: 0 4px 14px rgba(15, 40, 60, .06);--mk-elev-2: 0 10px 28px rgba(15, 40, 60, .09);--mk-elev-3: 0 20px 48px rgba(15, 40, 60, .14);--mk-elev-float: 0 26px 60px rgba(15, 40, 60, .2);--mk-space-1: 4px;--mk-space-2: 8px;--mk-space-3: 12px;--mk-space-4: 16px;--mk-space-5: 20px;--mk-space-6: 24px;--mk-space-8: 32px;--mk-space-10: 40px;--mk-ease-standard: cubic-bezier(.4, 0, .2, 1);--mk-ease-out: cubic-bezier(.16, 1, .3, 1);--mk-ease-spring: cubic-bezier(.34, 1.56, .64, 1);--mk-dur-fast: .16s;--mk-dur-base: .24s;--mk-dur-slow: .4s;--mk-blur-sm: 14px;--mk-blur: 20px;--mk-blur-xl: 28px;--mk-z-overlay: 50;--mk-z-drawer: 60;--mk-z-sheet: 70;--mk-z-cmdk: 80;--mk-z-toast: 90;--mk-z-portal: 100000;--mk-radius-card: var(--mk-radius-lg);--mk-elev-card: var(--mk-elev-2);--mk-tap-min: 40px;--mk-shell-blur: var(--mk-blur)}.mkai-admin.is-desktop{--mk-radius-card: var(--mk-radius-md);--mk-elev-card: var(--mk-elev-2);--mk-tap-min: 34px;--mk-shell-blur: var(--mk-blur-xl)}.mkai-admin.is-mobile{--mk-radius-card: var(--mk-radius-xl);--mk-elev-card: var(--mk-elev-1);--mk-tap-min: 44px;--mk-shell-blur: 30px}", Zt = ".mkai-admin.is-desktop{display:block;overflow:hidden}.mkai-admin.is-desktop .mk-console{display:grid;grid-template-columns:248px minmax(0,1fr);gap:14px;height:100%;min-height:0;padding:14px}.mkai-admin.is-desktop .mk-console__aside{display:flex;flex-direction:column;min-height:0;padding:16px 12px;border-radius:var(--mk-radius-xl);background:linear-gradient(180deg,#ffffffb8,#ffffff80);border:1px solid rgba(255,255,255,.6);box-shadow:var(--mk-elev-3),inset 0 1px #ffffffb3;backdrop-filter:blur(var(--mk-shell-blur)) saturate(1.4);-webkit-backdrop-filter:blur(var(--mk-shell-blur)) saturate(1.4)}.mkai-admin.is-desktop .mk-brand{display:flex;align-items:center;gap:10px;padding:6px 8px 16px}.mkai-admin.is-desktop .mk-brand__glyph{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;font-size:16px;color:var(--mk-on-accent);background:linear-gradient(135deg,var(--mk-brand-400),var(--mk-brand-700));box-shadow:0 6px 16px #0d948859}.mkai-admin.is-desktop .mk-brand__text{display:flex;flex-direction:column;line-height:1.1}.mkai-admin.is-desktop .mk-brand__name{font-weight:800;font-size:1.02rem;color:var(--mk-text)}.mkai-admin.is-desktop .mk-brand__sub{margin-top:3px;font-size:.68rem;font-weight:600;color:var(--mk-text-muted)}.mkai-admin.is-desktop .mk-nav{position:relative;flex:1;min-height:0;overflow-y:auto;padding:4px}.mkai-admin.is-desktop .mk-nav__slot{position:relative;z-index:1}.mkai-admin.is-desktop .mk-nav__group{padding:14px 10px 6px;font-size:.66rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mk-muted)}.mkai-admin.is-desktop .mk-nav__item{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:var(--mk-tap-min);padding:8px 12px;border:0;border-radius:var(--mk-radius-md);background:transparent;color:var(--mk-text-muted);font:inherit;font-weight:650;text-align:left;cursor:pointer;transition:color var(--mk-dur-fast) var(--mk-ease-standard),transform var(--mk-dur-fast) var(--mk-ease-standard)}.mkai-admin.is-desktop .mk-nav__item:hover{color:var(--mk-text)}.mkai-admin.is-desktop .mk-nav__item.is-active{color:var(--mk-accent-strong)}.mkai-admin.is-desktop .mk-nav__item:active{transform:scale(.98)}.mkai-admin.is-desktop .mk-nav__dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.35;transition:opacity var(--mk-dur-fast) var(--mk-ease-standard),transform var(--mk-dur-base) var(--mk-ease-spring)}.mkai-admin.is-desktop .mk-nav__item.is-active .mk-nav__dot{opacity:1;transform:scale(1.6)}.mkai-admin.is-desktop .mk-nav__liquid{position:absolute;top:0;left:0;z-index:0;border-radius:var(--mk-radius-md);background:linear-gradient(135deg,#14b8a638,#2dd4bf1f);border:1px solid rgba(20,184,166,.4);box-shadow:0 6px 18px #14b8a62e,inset 0 1px #fff9;opacity:0;transition:transform var(--mk-dur-base) var(--mk-ease-out),width var(--mk-dur-base) var(--mk-ease-out),height var(--mk-dur-base) var(--mk-ease-out),opacity var(--mk-dur-base) var(--mk-ease-out)}.mkai-admin.is-desktop .mk-nav__liquid.is-ready{opacity:1}.mkai-admin.is-desktop .mk-console__aside-foot{margin-top:6px;padding-top:10px;border-top:1px solid var(--mk-border)}.mkai-admin.is-desktop .mk-conn{display:flex;align-items:center;gap:8px;width:100%;min-height:var(--mk-tap-min);padding:8px 12px;border-radius:var(--mk-radius-md);border:1px solid var(--mk-border);background:#ffffff80;color:var(--mk-text-muted);font:inherit;font-size:.8rem;font-weight:650;cursor:pointer;transition:background var(--mk-dur-fast) var(--mk-ease-standard),border-color var(--mk-dur-fast) var(--mk-ease-standard)}.mkai-admin.is-desktop .mk-conn:hover{background:#fffc}.mkai-admin.is-desktop .mk-conn:disabled{cursor:progress}.mkai-admin.is-desktop .mk-conn__dot{width:8px;height:8px;border-radius:50%;background:var(--mk-muted)}.mkai-admin.is-desktop .mk-conn--ok .mk-conn__dot{background:var(--mk-success);box-shadow:0 0 10px #16a34a99}.mkai-admin.is-desktop .mk-conn--fail .mk-conn__dot{background:var(--mk-danger);box-shadow:0 0 10px #dc262680}.mkai-admin.is-desktop .mk-conn--checking .mk-conn__dot{background:var(--mk-warn);animation:mk-desk-pulse 1s var(--mk-ease-standard) infinite}@keyframes mk-desk-pulse{0%,to{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}.mkai-admin.is-desktop .mk-console__body{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-radius:var(--mk-radius-xl);background:linear-gradient(180deg,#ffffffa8,#ffffff70);border:1px solid rgba(255,255,255,.55);box-shadow:var(--mk-elev-3),inset 0 1px #fff9;backdrop-filter:blur(var(--mk-shell-blur)) saturate(1.3);-webkit-backdrop-filter:blur(var(--mk-shell-blur)) saturate(1.3)}.mkai-admin.is-desktop .mk-topbar{padding:13px 20px;border-bottom:1px solid var(--mk-border);background:linear-gradient(180deg,#ffffff80,#fff0)}.mkai-admin.is-desktop .mk-topbar__stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;width:100%}.mkai-admin.is-desktop .mk-topbar__tile{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:2px;min-width:0;width:100%;height:46px;padding:5px 12px;border-radius:var(--mk-radius-sm);border:1px solid var(--mk-border);background:#ffffff8c;overflow:hidden;box-sizing:border-box}.mkai-admin.is-desktop .mk-topbar__tile-label{font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mk-muted);line-height:1.2}.mkai-admin.is-desktop .mk-topbar__tile-value{font-size:.86rem;font-weight:720;color:var(--mk-text);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25}.mkai-admin.is-desktop .mk-stat__value.is-loading{color:var(--mk-muted)}.mkai-admin.is-desktop .mk-stat--ok .mk-stat__value{color:var(--mk-brand-700)}.mkai-admin.is-desktop .mk-stat--warn .mk-stat__value{color:var(--mk-warn)}.mkai-admin.is-desktop button.mk-topbar__tile{cursor:pointer;font:inherit;text-align:left;transition:background var(--mk-dur-fast) var(--mk-ease-standard),border-color var(--mk-dur-fast) var(--mk-ease-standard),color var(--mk-dur-fast) var(--mk-ease-standard),transform var(--mk-dur-slow) var(--mk-ease-out)}.mkai-admin.is-desktop .mk-topbar__cmdk:hover{background:#ffffffe6;border-color:var(--mk-accent-ring, rgba(20, 184, 166, .22))}.mkai-admin.is-desktop .mk-topbar__cmdk:hover .mk-topbar__tile-value{color:var(--mk-accent)}.mkai-admin.is-desktop .mk-topbar__refresh:hover{background:#ffffffe6;border-color:var(--mk-accent-ring, rgba(20, 184, 166, .22))}.mkai-admin.is-desktop .mk-topbar__refresh:hover .mk-topbar__tile-value{color:var(--mk-accent-strong)}.mkai-admin.is-desktop .mk-topbar__refresh:active .mk-topbar__tile-value{transform:rotate(180deg)}.mkai-admin.is-desktop .mk-console__main{flex:1;min-height:0;overflow-y:auto;padding:20px}.mkai-admin.is-desktop .mk-console__main:has(.mkai-page-sessions.is-chat){overflow:hidden;padding:0;display:flex;flex-direction:column}.mkai-admin.is-desktop .mk-console__main:has(.mkai-page-sessions.is-chat) .mk-console__page{flex:1;min-height:0;display:flex;flex-direction:column}.mkai-admin.is-desktop .mk-console__page{animation:mk-desk-in var(--mk-dur-base) var(--mk-ease-out) both}@keyframes mk-desk-in{0%{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.mkai-admin.is-desktop .mk-inspector{position:fixed;inset:0;z-index:var(--mk-z-drawer);display:grid;place-items:center;padding:24px;pointer-events:none}.mkai-admin.is-desktop .mk-inspector__scrim{position:fixed;inset:0;background:#0f283c47;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity var(--mk-dur-base) var(--mk-ease-standard)}.mkai-admin.is-desktop .mk-inspector.is-open{pointer-events:auto}.mkai-admin.is-desktop .mk-inspector.is-open .mk-inspector__scrim{opacity:1}.mkai-admin.is-desktop .mk-inspector__panel{position:relative;display:flex;flex-direction:column;width:min(560px,92vw);max-height:min(80vh,720px);border-radius:var(--mk-radius-xl, 24px);background:linear-gradient(180deg,#fffffff0,#ffffffdb);border:1px solid rgba(255,255,255,.6);box-shadow:var(--mk-elev-float);backdrop-filter:blur(var(--mk-blur-xl)) saturate(1.4);-webkit-backdrop-filter:blur(var(--mk-blur-xl)) saturate(1.4);overflow:hidden;opacity:0;transform:scale(.94);transition:opacity var(--mk-dur-base) var(--mk-ease-out),transform var(--mk-dur-base) var(--mk-ease-out)}.mkai-admin.is-desktop .mk-inspector.is-open .mk-inspector__panel{opacity:1;transform:scale(1)}.mkai-admin.is-desktop .mk-inspector__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--mk-border)}.mkai-admin.is-desktop .mk-inspector__title{font-size:1.05rem;font-weight:760;color:var(--mk-text)}.mkai-admin.is-desktop .mk-inspector__subtitle{margin-top:3px;font-size:.78rem;color:var(--mk-text-muted)}.mkai-admin.is-desktop .mk-inspector__close{display:grid;place-items:center;width:30px;height:30px;flex-shrink:0;border-radius:50%;border:1px solid var(--mk-border);background:#fff9;color:var(--mk-text-muted);font-size:18px;line-height:1;cursor:pointer;transition:background var(--mk-dur-fast),color var(--mk-dur-fast),transform var(--mk-dur-fast)}.mkai-admin.is-desktop .mk-inspector__close:hover{background:var(--mk-danger);color:#fff;transform:rotate(90deg)}.mkai-admin.is-desktop .mk-inspector__body{flex:1;min-height:0;overflow-y:auto;padding:18px 20px}.mkai-admin.is-desktop .mk-inspector__foot{padding:14px 20px;border-top:1px solid var(--mk-border)}@media(prefers-reduced-motion:reduce){.mkai-admin.is-desktop .mk-console__page,.mkai-admin.is-desktop .mk-nav__liquid,.mkai-admin.is-desktop .mk-nav__dot,.mkai-admin.is-desktop .mk-inspector__panel,.mkai-admin.is-desktop .mk-inspector__scrim,.mkai-admin.is-desktop .mk-inspector__close,.mkai-admin.is-desktop .mk-topbar__refresh,.mkai-admin.is-desktop .mk-conn--checking .mk-conn__dot{animation:none!important;transition:none!important}}.mkai-admin.is-desktop .mk-cmdk{position:fixed;inset:0;z-index:var(--mk-z-cmdk, 80);display:flex;align-items:center;justify-content:center;padding:24px}.mkai-admin.is-desktop .mk-cmdk__scrim{position:absolute;inset:0;background:#08141e52;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}.mkai-admin.is-desktop .mk-cmdk__panel{position:relative;width:min(560px,92vw);max-height:62vh;display:flex;flex-direction:column;background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:var(--mk-radius-lg, 18px);box-shadow:var(--mk-elev-float, 0 26px 60px rgba(15, 40, 60, .2));backdrop-filter:blur(var(--mk-shell-blur, 28px)) saturate(1.3);-webkit-backdrop-filter:blur(var(--mk-shell-blur, 28px)) saturate(1.3);overflow:hidden;animation:mk-cmdk-in var(--mk-dur-base, .24s) var(--mk-ease-out, ease)}@keyframes mk-cmdk-in{0%{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}.mkai-admin.is-desktop .mk-cmdk__search{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--panel-border)}.mkai-admin.is-desktop .mk-cmdk__icon{color:var(--mk-accent);font-size:16px}.mkai-admin.is-desktop .mk-cmdk__input{flex:1;border:0;background:transparent;outline:none;font:inherit;font-size:1rem;color:var(--mk-text)}.mkai-admin.is-desktop .mk-cmdk__kbd{font-size:11px;color:var(--mk-text-muted);border:1px solid var(--panel-border);border-radius:6px;padding:2px 6px}.mkai-admin.is-desktop .mk-cmdk__list{list-style:none;margin:0;padding:6px;overflow-y:auto}.mkai-admin.is-desktop .mk-cmdk__group{font-size:11px;font-weight:700;color:var(--mk-text-muted);padding:8px 10px 4px;letter-spacing:.02em}.mkai-admin.is-desktop .mk-cmdk__item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:0;background:transparent;border-radius:var(--mk-radius-sm, 10px);cursor:pointer;text-align:left;color:var(--mk-text);font:inherit}.mkai-admin.is-desktop .mk-cmdk__item.is-active{background:var(--mk-accent-soft, rgba(20, 184, 166, .12));color:var(--mk-accent-strong, #115e59)}.mkai-admin.is-desktop .mk-cmdk__item-label{font-weight:600}.mkai-admin.is-desktop .mk-cmdk__item-hint{font-size:12px;color:var(--mk-text-muted)}.mkai-admin.is-desktop .mk-cmdk__empty{padding:24px 12px;text-align:center;color:var(--mk-text-muted)}@media(prefers-reduced-motion:reduce){.mkai-admin.is-desktop .mk-cmdk__panel{animation:none}}", er = ".mkai-admin.is-mobile{display:block}.mkai-admin.is-mobile .mk-ios{position:relative;display:flex;flex-direction:column;height:100%;min-height:0}.mkai-admin.is-mobile .mk-ios__nav{position:relative;z-index:10;flex-shrink:0;padding:calc(env(safe-area-inset-top,0px) + 8px) 18px 8px;background:linear-gradient(180deg,#ffffff8c,#ffffff2e);backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);border-bottom:1px solid rgba(15,23,42,.06)}.mkai-admin.is-mobile .mk-ios__segment{display:flex;gap:2px;padding:3px;border-radius:10px;background:#7676801f}.mkai-admin.is-mobile .mk-ios__segment button{flex:1;min-height:32px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:.86rem;font-weight:640;color:var(--mk-text-muted);cursor:pointer;transition:background var(--mk-dur-base) var(--mk-ease-standard),color var(--mk-dur-base) var(--mk-ease-standard)}.mkai-admin.is-mobile .mk-ios__segment button.is-active{background:#fff;color:var(--mk-text);box-shadow:0 1px 3px #0f172a24}.mkai-admin.is-mobile .mk-ios__scroll{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:calc(env(safe-area-inset-top,0px) + 10px) 16px 24px}.mkai-admin.is-mobile .mk-ios:has(.mkai-page-sessions.is-chat) .mk-ios__scroll{overflow:hidden;padding:0;display:flex;flex-direction:column}.mkai-admin.is-mobile .mk-ios:has(.mkai-page-sessions.is-chat) .mk-ios__page{flex:1;min-height:0;display:flex;flex-direction:column}.mkai-admin.is-mobile .mkai-page-sessions.is-chat .im-pane-head{padding-top:calc(env(safe-area-inset-top,0px) + 8px)}.mkai-admin.is-mobile .mk-ios__page{animation:mk-ios-in .32s var(--mk-ease-out) both}@keyframes mk-ios-in{0%{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}.mkai-admin.is-mobile .mk-ios__tabbar{flex-shrink:0;display:flex;gap:2px;padding:8px 12px calc(8px + var(--mk-safe-bottom));background:#ffffffb3;backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);border-top:1px solid rgba(255,255,255,.6)}.mkai-admin.is-mobile .mk-ios__tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-height:var(--mk-tap-min);padding:5px 4px;border:0;border-radius:12px;background:transparent;font:inherit;color:var(--mk-muted);cursor:pointer;transition:color var(--mk-dur-base) var(--mk-ease-standard),transform var(--mk-dur-fast) var(--mk-ease-spring)}.mkai-admin.is-mobile .mk-ios__tab:active{transform:scale(.9)}.mkai-admin.is-mobile .mk-ios__tab.is-active{color:var(--mk-primary)}.mkai-admin.is-mobile .mk-ios__tab-glyph{font-size:20px;line-height:1}.mkai-admin.is-mobile .mk-ios__tab-label{font-size:.64rem;font-weight:640;letter-spacing:.02em}.mkai-admin.is-mobile .mk-sheet{position:fixed;inset:0;z-index:var(--mk-z-sheet);display:grid;place-items:center;padding:20px;pointer-events:none}.mkai-admin.is-mobile .mk-sheet__scrim{position:fixed;inset:0;background:#0f172a52;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity var(--mk-dur-base) var(--mk-ease-standard)}.mkai-admin.is-mobile .mk-sheet.is-open{pointer-events:auto}.mkai-admin.is-mobile .mk-sheet.is-open .mk-sheet__scrim{opacity:1}.mkai-admin.is-mobile .mk-sheet__panel{position:relative;display:flex;flex-direction:column;width:min(560px,92vw);max-height:82vh;padding:16px 18px calc(18px + var(--mk-safe-bottom));border-radius:var(--mk-radius-xl, 24px);background:#fffffff5;backdrop-filter:blur(30px) saturate(1.5);-webkit-backdrop-filter:blur(30px) saturate(1.5);box-shadow:var(--mk-elev-float, 0 26px 60px rgba(15, 40, 60, .2));opacity:0;transform:scale(.94);transition:opacity var(--mk-dur-base) var(--mk-ease-out),transform var(--mk-dur-base) var(--mk-ease-out)}.mkai-admin.is-mobile .mk-sheet.is-open .mk-sheet__panel{opacity:1;transform:scale(1)}.mkai-admin.is-mobile .mk-sheet__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0 2px 12px}.mkai-admin.is-mobile .mk-sheet__title{font-size:1.1rem;font-weight:760;color:var(--mk-text)}.mkai-admin.is-mobile .mk-sheet__subtitle{margin-top:3px;font-size:.8rem;color:var(--mk-text-muted)}.mkai-admin.is-mobile .mk-sheet__close{display:grid;place-items:center;width:32px;height:32px;flex-shrink:0;border-radius:50%;border:1px solid var(--mk-border);background:#ffffffb3;color:var(--mk-text-muted);font-size:20px;line-height:1;cursor:pointer}.mkai-admin.is-mobile .mk-sheet__body{overflow-y:auto}.mkai-admin.is-mobile .mk-sheet__foot{padding-top:12px}.mkai-admin.is-mobile .mk-sheet-list{display:flex;flex-direction:column;gap:8px}.mkai-admin.is-mobile .mk-sheet-list__item{display:flex;flex-direction:column;gap:2px;width:100%;padding:14px 16px;text-align:left;border:1px solid var(--mk-border);border-radius:var(--mk-radius-md);background:#fff9;font:inherit;cursor:pointer;transition:background var(--mk-dur-fast),transform var(--mk-dur-fast)}.mkai-admin.is-mobile .mk-sheet-list__item:active{transform:scale(.98);background:#ffffffeb}.mkai-admin.is-mobile .mk-sheet-list__label{font-size:.96rem;font-weight:700;color:var(--mk-text)}.mkai-admin.is-mobile .mk-sheet-list__desc{font-size:.78rem;color:var(--mk-text-muted)}@media(prefers-reduced-motion:reduce){.mkai-admin.is-mobile .mk-ios__page,.mkai-admin.is-mobile .mk-ios__tab,.mkai-admin.is-mobile .mk-ios__segment button,.mkai-admin.is-mobile .mk-sheet__panel,.mkai-admin.is-mobile .mk-sheet__scrim,.mkai-admin.is-mobile .mk-sheet-list__item{animation:none!important;transition:none!important}}.mkai-admin.is-mobile{-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%}.mkai-admin.is-mobile button,.mkai-admin.is-mobile [role=switch],.mkai-admin.is-mobile [role=radio],.mkai-admin.is-mobile .mk-input,.mkai-admin.is-mobile .mk-search-field__input,.mkai-admin.is-mobile textarea,.mkai-admin.is-mobile select{touch-action:manipulation}.mkai-admin.is-mobile .mk-ios__nav,.mkai-admin.is-mobile .mk-ios__tabbar,.mkai-admin.is-mobile .mk-ios__segment{-webkit-user-select:none;user-select:none}.mkai-admin.is-mobile .mk-ios__scroll{overscroll-behavior:contain}.mkai-admin.is-mobile .mk-btn{min-height:var(--mk-tap-min)}.mkai-admin.is-mobile .mk-input,.mkai-admin.is-mobile .mk-search-field__input,.mkai-admin.is-mobile textarea,.mkai-admin.is-mobile select{font-size:max(16px,1rem);min-height:var(--mk-tap-min)}";
function Xe(a, i) {
  q(() => {
    const t = document.createElement("style");
    return t.setAttribute("data-mkai-admin", i), t.textContent = a, document.head.appendChild(t), () => {
      t.remove();
    };
  }, [a, i]);
}
function ar({
  apiBase: a,
  fetchFn: i
}) {
  const t = Z(() => yi(a, i), [a, i]), { toast: n, confirm: l } = Ht();
  return /* @__PURE__ */ e(Qt, { api: t, toast: n, confirm: l });
}
function nr(a) {
  const i = Ke();
  Xe(Jt, "base"), Xe(Xt, "tokens"), Xe(i === "mobile" ? er : Zt, "skin");
  const t = j(null);
  return /* @__PURE__ */ o(
    "div",
    {
      ref: t,
      className: `mkai-admin is-${i}`,
      style: { position: "relative", height: "100%", minHeight: "100%" },
      children: [
        /* @__PURE__ */ e(Ci, { children: /* @__PURE__ */ e(Yt, { children: /* @__PURE__ */ e(ar, { apiBase: a.apiBase, fetchFn: a.fetch }) }) }),
        i === "desktop" ? /* @__PURE__ */ e(Wt, { rootRef: t }) : null
      ]
    }
  );
}
export {
  nr as default
};
