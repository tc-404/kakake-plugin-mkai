import { useEffect, useMemo, useRef } from 'react';
import type { PluginRemoteProps } from './plugin-remote-contract';
import { createApi } from './api';
import { MkaiAdminApp } from './App';
import { CustomCursor } from './components/CustomCursor';
import { useDeviceKind } from './hooks/useDeviceKind';
import { NotifyProvider, useNotify } from './notify';
import { OverlayProvider } from './shell/overlay';
import baseCss from './styles.css?inline';
import tokensCss from './tokens.css?inline';
import desktopCss from './desktop.css?inline';
import mobileCss from './mobile.css?inline';

/** 注入一段作用域 CSS；cssText 变化（如切换设备皮肤）时自动替换 */
function useInjectCss(cssText: string, layer: string) {
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-mkai-admin', layer);
    el.textContent = cssText;
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [cssText, layer]);
}

function MkaiShell({
  apiBase,
  fetchFn,
}: {
  apiBase: string;
  fetchFn: typeof fetch;
}) {
  const api = useMemo(() => createApi(apiBase, fetchFn), [apiBase, fetchFn]);
  const { toast, confirm } = useNotify();
  return <MkaiAdminApp api={api} toast={toast} confirm={confirm} />;
}

export default function MkaiRemote(props: PluginRemoteProps) {
  const kind = useDeviceKind();
  // 共享底座始终注入；设备皮肤二选一，随设备类型实时切换
  useInjectCss(baseCss, 'base');
  useInjectCss(tokensCss, 'tokens');
  useInjectCss(kind === 'mobile' ? mobileCss : desktopCss, 'skin');
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rootRef}
      className={`mkai-admin is-${kind}`}
      style={{ position: 'relative', height: '100%', minHeight: '100%' }}
    >
      <OverlayProvider>
        <NotifyProvider>
          <MkaiShell apiBase={props.apiBase} fetchFn={props.fetch} />
        </NotifyProvider>
      </OverlayProvider>
      {kind === 'desktop' ? <CustomCursor rootRef={rootRef} /> : null}
    </div>
  );
}