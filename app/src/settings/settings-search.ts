import { tools } from './model';
import { navigationItems, type PageId } from './navigation';

export interface SettingTarget { label: string; control?: string }
export interface SettingsSearchEntry {
  id: string; label: string; page: PageId | 'extensions'; kind: '页面' | '设置' | '入口';
  description: string; keywords: string; target?: SettingTarget;
}
const field = (id: string, page: PageId, label: string, keywords: string, target: SettingTarget = {label}, description = ''): SettingsSearchEntry => ({id,page,label,keywords,target,description,kind:'设置'});
const entry = (id: string, page: PageId, label: string, target: SettingTarget, description: string, keywords: string): SettingsSearchEntry => ({id,page,label,target,description,keywords,kind:'入口'});
const pageEntries: SettingsSearchEntry[] = navigationItems.map(item=>({id:`page:${item.id}`,label:item.label,page:item.id,kind:'页面',description:item.group,keywords:item.keywords}));

// Search indexes host controls, never personal catalog/clipboard contents or
// filesystem data. Selecting an entry only navigates and locates its control.
export const settingsSearchEntries: readonly SettingsSearchEntry[] = [
  ...pageEntries,
  {id:'page:extensions',label:'插件市场',page:'extensions',kind:'页面',description:'打开独立插件工作区',keywords:'插件 安装 扩展 更新 卸载 marketplace plugin extension'},
  field('launcher-hotkey','core','唤出 FlowHub','快捷键 热键 召唤 启动器 hotkey shortcut launcher'),
  field('launch-at-login','core','开机自动启动','登录 开机启动 自动启动 自启动 自启 launch login startup'),
  field('proxy-adapter','core','代理检测适配器','网络 代理 clash mihomo system proxy adapter'),
  field('notifications','core','允许通知','系统 消息 提醒 notification'),
  field('update-notifications','core','更新通知','通知 升级 消息 update notification'),
  entry('notification-permission','core','系统通知权限',{label:'系统通知权限'},'前往测试通知入口，选中不会发送通知','授权 系统 测试 通知 permission notification'),
  field('theme','appearance','外观主题','浅色 深色 跟随系统 夜间 颜色 theme dark light system'),
  field('all-scope-key','search','全部结果范围键','搜索 全部 快捷键 范围键 scope shortcut'),
  field('source-order','search','搜索来源与顺序','排序 优先 拖拽 调整 source order ranking'),
  ...(['app','web','clipboard','memo'] as const).map((id,index)=>{
    const label=['应用','网页目录','剪贴板','备忘录'][index];
    return field(`scope-key:${id}`,'search',`${label}范围键`,`搜索 快捷键 ${id} scope shortcut`,{label:`${label}搜索来源`,control:`${label}范围键`});
  }),
  field('reuse-browser-tabs','search','优先复用浏览器标签页','网页 浏览器 Arc 重复 打开 browser tabs reuse'),
  field('long-content-preview','search','长内容自动预览','长文本 多行 剪贴板 命令 详情 展开 自动 preview automatic long content'),
  field('search-history','search','记录搜索历史','查询 历史 补全 记忆 隐私 暂停 history completion query'),
  ...Object.entries({enabled:'显示 FlowHub 图标',showOpenLauncher:'打开启动器',showOpenSettings:'打开设置',showVersion:'显示版本',showQuit:'退出菜单',organizerEnabled:'启用菜单栏隐藏分区',collapseOnLaunch:'启动时收起隐藏分区'}).map(([id,label])=>field(`menubar:${id}`,'menubar',label,`菜单栏 状态栏 隐藏 图标 menubar ${id}`)),
  entry('menubar-permission','menubar','菜单栏辅助功能权限',{label:'菜单栏设置与权限',control:'授权辅助功能'},'定位授权按钮，选中不会请求权限','菜单栏权限 辅助功能权限 菜单栏 授权 permission accessibility'),
  field('canvas-locked','canvas','锁定布局','桌面 组件 拖动 缩放 canvas widget lock'),
  field('canvas-view-only','canvas','仅查看桌面组件','桌面 组件 只读 点击 canvas widget readonly'),
  field('application-search','app','启用应用搜索','应用 扫描 启动 app application search'),
  entry('application-permission','app','辅助功能权限',{label:'辅助功能权限'},'定位系统设置入口，选中不会请求权限','应用 授权 系统 permission accessibility'),
  field('clipboard-pause','clipboard','暂停采集','暂停剪贴板 暂停复制 暂停记录 剪贴板 敏感 clipboard capture pause'),
  field('clipboard-protection','clipboard','敏感标记保护','剪贴板 隐私 密码 敏感 clipboard privacy sensitive'),
  field('clipboard-retention','clipboard','留存天数','保留天数 保留时间 剪贴板 历史 过期 清理 retention days history'),
  field('clipboard-records','clipboard','最多记录条数','记录上限 最大记录数 历史数量 剪贴板 上限 max records limit'),
  field('clipboard-capacity','clipboard','逻辑内容容量（字节）','剪贴板 空间 大小 容量 字节 max bytes size storage'),
  field('config-location','data','配置文件位置','存储 目录 路径 保存 文件 config location path'),
  field('database-location','data','数据库与剪贴板目录','数据库 目录 路径 迁移 存储 database sqlite storage path'),
  entry('config-history','data','配置历史',{label:'配置历史',control:'查看差异'},'查看历史版本与差异，选中不会恢复配置','恢复历史 历史恢复 配置备份 历史 版本 回退 backup history restore'),
  entry('config-import','data','导入配置',{label:'导入与导出',control:'导入配置…'},'定位导入按钮，文件需另行选择','导入 迁移 配置 import migrate'),
  entry('config-export','data','导出配置',{label:'导入与导出',control:'导出配置…'},'定位导出按钮，选中不会写文件','导出 备份 配置 export backup'),
  field('diagnostics','data','性能采样','诊断 性能 资源 监控 CPU 内存 memory diagnostics performance'),
  entry('clear-diagnostics','data','清理性能采样',{label:'本地诊断',control:'清理采样'},'定位清理按钮，仍需单独确认','删除 清理 采样 诊断 clear diagnostics'),
  field('auto-update-check','updates','自动检查正式版','更新 检查 版本 自动 update check'),
  field('auto-update-install','updates','自动下载并重启安装','更新 下载 升级 重启 自动 update install download'),
  entry('check-update','updates','检查更新',{label:'版本状态',control:'检查更新'},'定位检查按钮，选中不会访问网络','版本 升级 正式版 update version check'),
  ...Object.entries(tools).map(([id,label])=>field(`tool:${id}`,'tools',label,`工具 启用 关闭 ${id}`)),
  entry('clear-command-history','tools','清空命令历史与模板',{label:'命令历史与参数模板',control:'清空历史与模板'},'定位清空按钮，仍需单独确认','清空历史 清除历史 删除历史 清除 删除 历史 模板 command history templates clear'),
];
const recommended = ['launcher-hotkey','theme','launch-at-login','clipboard-retention','database-location','config-history','page:extensions'];
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const prepared = settingsSearchEntries.map(item=>{
  const page=navigationItems.find(page=>page.id===item.page);
  return {item,title:normalize(item.label),text:normalize([item.label,item.description,item.keywords,page?.label,page?.group].join(' '))};
});
export function findSettings(query: string): SettingsSearchEntry[] {
  const text=normalize(query),terms=text.split(/\s+/).filter(Boolean);
  if(!terms.length)return [...recommended.flatMap(id=>settingsSearchEntries.find(item=>item.id===id) || []),...pageEntries];
  return prepared.filter(entry=>terms.every(term=>entry.text.includes(term))).map(entry=>({item:entry.item,score:entry.title===text?0:entry.title.startsWith(text)?1:entry.title.includes(text)?2:entry.item.kind==='页面'?4:3})).sort((a,b)=>a.score-b.score).slice(0,60).map(entry=>entry.item);
}
