/** 与 kakake `src/web/lib/plugin-remote.ts` 对齐的本地契约副本 */
import type { ComponentType } from 'react';

export interface PluginRemoteProps {
  pluginId: string;
  accountKey: string;
  pagePath: string;
  apiBase: string;
  moduleBase: string;
  navigate: (to: string) => void;
  fetch: typeof globalThis.fetch;
}

export type PluginRemoteComponent = ComponentType<PluginRemoteProps>;
