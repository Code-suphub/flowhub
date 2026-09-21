import { useSyncExternalStore } from 'react';
import { Tabs } from '../shared/ui';
const sections = [
  { id: 'general', label: '基础', help: '修改快捷键或登录启动设置，保存后立即生效。' },
  { id: 'search', label: '搜索入口', help: '集中管理搜索来源、启停状态和范围快捷键。' },
  { id: 'network', label: '网络', help: '选择 FlowHub 读取本机代理状态的方式。' },
  { id: 'menubar', label: '菜单栏', help: '设置 FlowHub 菜单内容，以及菜单栏图标的显示与整理。' },
  { id: 'notifications', label: '通知', help: '选择需要接收的应用通知，并检查系统通知权限。' },
  { id: 'data', label: '数据与诊断', help: '查看配置文件位置，或采样本机性能数据以排查问题。' },
  { id: 'updates', label: '更新', help: '查看版本和安装进度，设置自动检查与安装策略。' },
];
declare global { interface Window { FlowHubSettingsNavigation: { getSection: () => string; selectSection: (id: string) => void } } }
function subscribe(listener: () => void) {
  window.addEventListener('flowhub:settings-section', listener);
  return () => window.removeEventListener('flowhub:settings-section', listener);
}
export function Navigation() {
  const section = useSyncExternalStore(subscribe, () => window.FlowHubSettingsNavigation.getSection());
  return <div className="fh-root"><Tabs label="通用设置分类" items={sections} value={section} onChange={id => window.FlowHubSettingsNavigation.selectSection(id)} /></div>;
}
