import { Progress, ProgressLabel } from '../components/ui/progress';
import type { InstallProgress } from './api';

const labels={preparing:'准备安装',downloading:'下载安装包',verifying:'校验签名与完整性',extracting:'解包并检查插件',applying:'保存安装结果',complete:'安装完成'};
export function InstallStatus({progress}: {progress:InstallProgress}) {
  const downloading=progress.phase==='downloading';
  const percent=downloading && progress.total?Math.min(100,Math.floor((progress.received || 0)/progress.total*100)):null;
  const bytes=(value:number)=>`${(value/1024/1024).toFixed(1)} MB`;
  return <div className="market-install-status flex flex-col gap-2 mt-4">
    <Progress value={percent} aria-label="插件安装进度"><ProgressLabel>{labels[progress.phase]}</ProgressLabel>{percent!==null?<span className="market-meta ml-auto">{percent}%</span>:null}</Progress>
    <p className="market-meta" role="status">{downloading?`${bytes(progress.received || 0)}${progress.total?` / ${bytes(progress.total)}`:''}`:'请等待当前步骤完成。安装失败会保留原版本。'}</p>
  </div>;
}
