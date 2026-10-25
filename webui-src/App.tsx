import { useState } from 'react';
import type { MkaiApiClient, ViewId } from './api';
import { useDeviceKind } from './hooks/useDeviceKind';
import type { ConfirmFn, ToastFn } from './notify';
import { BlacklistPage } from './pages/BlacklistPage';
import { ConfigPage } from './pages/ConfigPage';
import { OverviewPage } from './pages/OverviewPage';
import { SessionsPage } from './pages/SessionsPage';
import { SwitchPage } from './pages/SwitchPage';
import { VoicePage } from './pages/VoicePage';
import { DesktopShell } from './shell/DesktopShell';
import { MobileShell } from './shell/MobileShell';
import { NAV } from './shell/nav';
/** 按当前视图渲染对应页面；桌面与手机两套壳共用同一份页面视图 */
function PageOutlet({
  view,
  api,
  toast,
  confirm,
}: {
  view: ViewId;
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}) {
  if (view === 'overview') return <OverviewPage api={api} />;
  if (view === 'switch') return <SwitchPage api={api} toast={toast} />;
  if (view === 'voice') return <VoicePage api={api} toast={toast} />;
  if (view === 'blacklist') return <BlacklistPage api={api} toast={toast} confirm={confirm} />;
  if (view === 'sessions') return <SessionsPage api={api} toast={toast} confirm={confirm} />;
  return <ConfigPage api={api} toast={toast} confirm={confirm} section={view} />;
}

export function MkaiAdminApp({
  api,
  toast,
  confirm,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}) {
  const kind = useDeviceKind();
  const [view, setView] = useState<ViewId>('overview');
  const outlet = <PageOutlet view={view} api={api} toast={toast} confirm={confirm} />;

  return kind === 'desktop' ? (
    <DesktopShell nav={NAV} view={view} setView={setView} api={api}>
      {outlet}
    </DesktopShell>
  ) : (
    <MobileShell view={view} setView={setView}>
      {outlet}
    </MobileShell>
  );
}