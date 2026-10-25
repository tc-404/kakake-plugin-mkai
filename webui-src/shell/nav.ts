import type { ViewId } from '../api';

export interface NavItem {
  id: ViewId;
  /** 桌面侧栏用四字标签 */
  label: string;
  /** 手机底栏用两字短名 */
  short: string;
  /** 分组名（桌面侧栏分组标题） */
  group?: string;
}

/** 一级导航；桌面按 group 分组展示，手机取 short */
export const NAV: NavItem[] = [
  { id: 'overview', label: '数据总览', short: '总览', group: '总览' },
  { id: 'model', label: '模型接入', short: '模型', group: '配置' },
  { id: 'policy', label: '对话策略', short: '策略', group: '配置' },
  { id: 'skills', label: '能力扩展', short: '能力', group: '配置' },
  { id: 'voice', label: '语音输出', short: '语音', group: '配置' },
  { id: 'rotation', label: '模型轮替', short: '轮替', group: '配置' },
  { id: 'blacklist', label: '黑户管理', short: '黑户', group: '运维' },
  { id: 'switch', label: '聊天开关', short: '开关', group: '运维' },
  { id: 'sessions', label: '会话管理', short: '会话', group: '运维' },
];