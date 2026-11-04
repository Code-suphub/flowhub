import { AppWindowIcon, ArchiveIcon, ClipboardIcon, Globe2Icon, LayoutDashboardIcon, NotebookPenIcon, PaletteIcon, PanelTopIcon, RefreshCwIcon, SearchIcon, Settings2Icon, WrenchIcon } from 'lucide-react';

export const navigationGroups = [
  {label:'系统设置',items:[
    {id:'core',label:'通用设置',Icon:Settings2Icon,keywords:'通用 常规 快捷键 启动 开机 热键 通知 代理 general hotkey'},
    {id:'appearance',label:'外观',Icon:PaletteIcon,keywords:'外观 主题 深色 浅色 透明 theme'},
    {id:'data',label:'数据与诊断',Icon:ArchiveIcon,keywords:'数据 诊断 导入 导出 备份 恢复 配置 文件 位置 性能 database'},
    {id:'updates',label:'版本与更新',Icon:RefreshCwIcon,keywords:'版本 更新 升级 下载 关于 update version'},
  ]},
  {label:'工作空间',items:[
    {id:'search',label:'搜索',Icon:SearchIcon,keywords:'搜索 来源 顺序 范围键 search'},
    {id:'menubar',label:'菜单栏',Icon:PanelTopIcon,keywords:'菜单栏 隐藏 图标 menu'},
    {id:'canvas',label:'桌面组件',Icon:LayoutDashboardIcon,keywords:'桌面 组件 画布 锁定 常驻 canvas widget'},
  ]},
  {label:'目录与工具',items:[
    {id:'web',label:'网页目录',Icon:Globe2Icon,keywords:'网页 书签 收藏 网站 分组 bookmark'},
    {id:'app',label:'应用',Icon:AppWindowIcon,keywords:'应用 程序 启动 扫描 app'},
    {id:'clipboard',label:'剪贴板',Icon:ClipboardIcon,keywords:'剪贴板 历史 复制 图片 存储 clipboard'},
    {id:'memo',label:'备忘录',Icon:NotebookPenIcon,keywords:'备忘 代码 命令 标签 memo'},
    {id:'tools',label:'工具',Icon:WrenchIcon,keywords:'工具 计算 时间 网络 JSON URL tool'},
  ]},
] as const;
export const navigationItems=navigationGroups.flatMap(group=>group.items.map(item=>({...item,group:group.label})));
export type PageId=(typeof navigationItems)[number]['id'];
export function isPage(id:string):id is PageId {return navigationItems.some(item=>item.id===id);}
export function matchingNavigation(query:string) {
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return navigationGroups.map(group=>({...group,items:group.items.filter(item=>terms.every(term=>`${item.label} ${item.keywords} ${group.label}`.toLocaleLowerCase().includes(term)))})).filter(group=>group.items.length);
}
export function corePage(section:string):PageId {
  return section==='data' || section==='updates' || section==='search' || section==='menubar'?section:'core';
}
