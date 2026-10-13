/**
 * 从 MK/webui/admin.html 抽取智能对话 CSS / JS 片段，供 React 后台迁移对照。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const mkAdmin = path.resolve(root, '../../MK/webui/admin.html');
const outDir = path.join(root, 'webui-src');

const admin = fs.readFileSync(mkAdmin, 'utf8');
const lines = admin.split(/\r?\n/);

function sliceLines(start, end) {
  return lines.slice(start - 1, end).join('\n');
}

const scCss = sliceLines(3235, 4034)
  .replace(/#page-smart-chat-switch/g, '.mkai-page-switch')
  .replace(/#page-smart-chat/g, '.mkai-page-config')
  .replace(/#scAiOnlyModal/g, '.mkai-ai-only-modal')
  .replace(/#scKbModal/g, '.mkai-kb-modal');

const shell = `
.mkai-admin {
  --mk-text: #1e293b;
  --mk-text-muted: #64748b;
  --mk-muted: #64748b;
  --mk-primary: #3b82f6;
  --mk-success: #16a34a;
  --mk-surface: #ffffff;
  --mk-border: #e2e8f0;
  --mk-safe-bottom: env(safe-area-inset-bottom, 0px);
  --sidebar-w: 200px;
  --font: "Manrope", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-sizing: border-box;
  display: flex;
  min-height: 100%;
  height: 100%;
  color: var(--mk-text);
  font-family: var(--font);
  overflow: hidden;
  background:
    radial-gradient(900px 520px at 8% -6%, rgba(59, 130, 246, .18), transparent 55%),
    radial-gradient(780px 480px at 96% 4%, rgba(56, 189, 248, .14), transparent 52%),
    linear-gradient(155deg, #eff6ff 0%, #f8fafc 45%, #eef2ff 100%);
}
.mkai-admin *, .mkai-admin *::before, .mkai-admin *::after { box-sizing: border-box; }
.mkai-admin .sidebar {
  width: var(--sidebar-w); flex-shrink: 0; display: flex; flex-direction: column; gap: 4px;
  padding: 18px 12px; background: rgba(255,255,255,.35); backdrop-filter: blur(16px);
  border-right: 1px solid rgba(255,255,255,.45); overflow: auto;
}
.mkai-admin .brand { font-weight: 800; font-size: 1.25rem; padding: 8px 10px 18px; line-height: 1.15; }
.mkai-admin .brand .mark {
  background: linear-gradient(120deg, #2563eb 10%, #3b82f6 55%, #38bdf8 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.mkai-admin .brand small { display:block; font-size: .72rem; font-weight: 600; color: var(--mk-muted); margin-top: 6px; }
.mkai-admin .nav-btn {
  border: 0; background: transparent; text-align: left; padding: 10px 12px; border-radius: 12px;
  cursor: pointer; color: var(--mk-text); font: inherit; font-weight: 600;
}
.mkai-admin .nav-btn:hover { background: rgba(255,255,255,.45); }
.mkai-admin .nav-btn.is-active { background: rgba(59,130,246,.14); color: #1d4ed8; }
.mkai-admin .main { flex: 1; min-width: 0; overflow: auto; padding: 16px 18px 28px; }
.mkai-admin .glass-card {
  background: rgba(255,255,255,.55); backdrop-filter: blur(14px);
  border: 1px solid rgba(255,255,255,.55); border-radius: 18px;
  box-shadow: 0 8px 24px rgba(148,163,184,.16); overflow: hidden;
}
.mkai-admin .mk-panel-head { padding: 16px 18px 10px; border-bottom: 1px solid rgba(15,23,42,.06); }
.mkai-admin .mk-panel-body { padding: 16px 18px 20px; }
.mkai-admin .mk-title-lg { margin: 0; font-size: 1.2rem; font-weight: 750; }
.mkai-admin .mk-label { display:block; font-size: 13px; font-weight: 650; margin-bottom: 6px; }
.mkai-admin .mk-hint { font-size: 12px; color: var(--mk-muted); line-height: 1.45; }
.mkai-admin .mk-form-group { margin-bottom: 12px; }
.mkai-admin .mk-input {
  width: 100%; border: 1px solid color-mix(in srgb, var(--mk-border) 80%, transparent);
  background: rgba(255,255,255,.72); border-radius: 10px; padding: 9px 11px; font: inherit; color: inherit;
}
.mkai-admin .mk-input:focus { outline: 2px solid rgba(59,130,246,.35); border-color: #93c5fd; }
.mkai-admin .mk-btn {
  border: 0; border-radius: 10px; padding: 9px 14px; font: inherit; font-weight: 650; cursor: pointer;
}
.mkai-admin .mk-btn--primary { background: #3b82f6; color: #fff; }
.mkai-admin .mk-btn--primary:hover { background: #2563eb; }
.mkai-admin .mk-btn--ghost { background: rgba(15,23,42,.06); color: var(--mk-text); }
.mkai-admin .mk-btn--sm { padding: 6px 10px; font-size: 13px; }
.mkai-admin .mk-btn-row { display:flex; flex-wrap:wrap; gap: 8px; margin-top: 12px; }
.mkai-admin .mk-seg { display:flex; flex-wrap:wrap; gap: 6px; }
.mkai-admin .mk-seg__btn {
  border: 0; background: rgba(15,23,42,.05); border-radius: 999px; padding: 7px 12px;
  font: inherit; font-weight: 650; cursor: pointer; color: var(--mk-text-muted);
}
.mkai-admin .mk-seg__btn--active { background: rgba(59,130,246,.16); color: #1d4ed8; }
.mkai-admin .mk-cs-tab-panel { display: none; }
.mkai-admin .mk-cs-tab-panel.is-active { display: block; }
.mkai-admin .toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(16px);
  background: rgba(15,23,42,.88); color: #fff; padding: 10px 16px; border-radius: 999px;
  opacity: 0; pointer-events: none; transition: .2s ease; z-index: 50; font-size: 13px; max-width: 90vw;
}
.mkai-admin .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.mkai-admin .mk-modal-overlay {
  position: fixed; inset: 0; background: rgba(15,23,42,.35); display:flex; align-items:center; justify-content:center;
  z-index: 40; padding: 16px;
}
.mkai-admin .mk-modal {
  background: rgba(255,255,255,.92); backdrop-filter: blur(16px); border-radius: 16px;
  padding: 18px; width: 100%; box-shadow: 0 20px 50px rgba(15,23,42,.2);
}
.mkai-admin .mk-modal__title { margin: 0 0 8px; font-size: 1.05rem; }
.mkai-admin .mobile-tabbar { display:none; }
.mkai-admin .mk-switch-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
}
.mkai-admin .mk-tabs-inline { display:flex; align-items:center; gap: 8px; }
.mkai-admin .mk-tab-pill {
  border: 0; background: transparent; font: inherit; font-weight: 700; cursor: pointer; color: var(--mk-muted); padding: 6px 4px;
}
.mkai-admin .mk-tab-pill--active { color: #1d4ed8; }
.mkai-admin .mk-tab-sep { opacity: .35; }
.mkai-admin .bulk-btn {
  border: 0; background: rgba(59,130,246,.12); color: #1d4ed8; border-radius: 999px;
  padding: 7px 12px; font: inherit; font-weight: 650; cursor: pointer;
}
.mkai-admin .mk-search-field {
  margin-top: 12px; display:flex; align-items:center; gap: 8px;
  background: rgba(255,255,255,.7); border: 1px solid rgba(15,23,42,.08); border-radius: 12px; padding: 8px 10px;
}
.mkai-admin .mk-search-field__input {
  flex:1; border:0; background: transparent; font: inherit; outline: none;
}
.mkai-admin .mk-search-field__clear {
  border:0; background: transparent; cursor:pointer; color: var(--mk-muted); display:flex;
}
.mkai-admin .mk-state { padding: 28px 12px; text-align:center; color: var(--mk-muted); }
.mkai-admin .mk-switch-list { display:flex; flex-direction: column; gap: 10px; }
.mkai-admin .broadcast-toolbar__check {
  display:flex; align-items:center; gap: 8px; margin-top: 10px; cursor: pointer;
}
@media (max-width: 760px) {
  .mkai-admin { flex-direction: column; }
  .mkai-admin .sidebar { display:none; }
  .mkai-admin .mobile-tabbar {
    display:flex; position: sticky; bottom: 0; gap: 4px; padding: 8px 10px calc(8px + var(--mk-safe-bottom));
    background: rgba(255,255,255,.8); backdrop-filter: blur(14px); border-top: 1px solid rgba(15,23,42,.06);
  }
  .mkai-admin .mobile-tabbar button {
    flex:1; border:0; background:transparent; padding: 10px 6px; border-radius: 12px; font:inherit; font-weight:700; cursor:pointer;
  }
  .mkai-admin .mobile-tabbar button.is-active { background: rgba(59,130,246,.14); color:#1d4ed8; }
}
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'styles.css'),
  `/* MK_AI — smart-chat UI styles (from MKbot admin.html + GF_mk shell) */\n${shell}\n${scCss}\n`,
);

const jsStart = lines.findIndex((l) => l.includes('智能对话 WebUI'));
let jsEnd = -1;
for (let i = jsStart + 1; i < lines.length; i++) {
  if (lines[i].includes('// ==================') && !lines[i].includes('智能对话')) {
    jsEnd = i;
    break;
  }
}
const js = lines.slice(jsStart, jsEnd > 0 ? jsEnd : jsStart + 1600).join('\n');
fs.writeFileSync(path.join(outDir, '_extracted_smart_chat.js'), js);

console.log('[extract] styles.css', fs.statSync(path.join(outDir, 'styles.css')).size);
console.log('[extract] js lines', jsStart + 1, '→', (jsEnd > 0 ? jsEnd : jsStart + 1600), 'bytes', js.length);
