use serde_json::{json,Value};
use std::{path::PathBuf,sync::{Arc,Mutex,OnceLock},time::{Duration,Instant}};
#[cfg(target_os = "macos")]
#[path = "admin_monitor.rs"]
mod macos;

#[derive(Default)]
struct Status {value:Option<Value>,at:Option<Instant>,checking:bool,generation:u64,client:Option<PathBuf>}
static STATUS:OnceLock<Arc<Mutex<Status>>>=OnceLock::new();
fn state()->Arc<Mutex<Status>> {STATUS.get_or_init(||Arc::new(Mutex::new(Status::default()))).clone()}
fn publish(status:&mut Status,mut next:Value) {
    if next["status"]=="unreachable" {
        if let Some(previous)=&status.value {
            if previous["status"]=="enabled"||previous["status"]=="needsUpdate" {
                let warning=next["message"].clone();next=previous.clone();next["warning"]=warning;next["stale"]=json!(true);
            }
        }
    }
    status.value=Some(next);status.at=Some(Instant::now());status.checking=false;
}
#[cfg(target_os="macos")]
fn cached_status(client:Option<PathBuf>)->Value {
    let shared=state();
    let mut status=shared.lock().unwrap_or_else(|p|p.into_inner());
    if status.client!=client {status.client=client.clone();status.value=None;status.at=None;status.generation+=1;status.checking=false;}
    if !status.checking&&status.at.is_none_or(|at|at.elapsed()>=Duration::from_secs(5)) {
        status.checking=true;
        let generation=status.generation;
        let worker=shared.clone();
        // Filesystem/signature checks and socket I/O never run on a caller's
        // request path. All windows share one bounded background query.
        tauri::async_runtime::spawn_blocking(move|| {
            let next=macos::invoke("status",client.as_deref()).unwrap_or_else(|_|json!({"ok":false,"status":"unreachable","message":"暂时无法读取进程服务状态，稍后会自动重试。"}));
            let mut state=worker.lock().unwrap_or_else(|p|p.into_inner());
            if state.generation==generation {publish(&mut state,next);}
        });
    }
    let mut value=status.value.clone().unwrap_or_else(||json!({"ok":false,"status":"checking","message":"正在检查进程服务授权状态…"}));
    value["checking"]=json!(status.checking);value
}
pub(crate) async fn invoke(action:&str,client:Option<PathBuf>)->Result<Value,String> {
    if !matches!(action,"status"|"enable"|"disable") {return Err("不支持的系统进程授权操作".into());}
    #[cfg(not(target_os="macos"))]
    return Err("系统级进程授权只支持 macOS。".into());
    #[cfg(target_os="macos")]
    {
        if action=="status" {return Ok(cached_status(client));}
        let shared=state();
        {let mut state=shared.lock().unwrap_or_else(|p|p.into_inner());state.generation+=1;state.checking=false;}
        let action=action.to_owned();
        let result=tauri::async_runtime::spawn_blocking(move||macos::invoke(&action,client.as_deref())).await.map_err(|error|format!("系统进程授权任务失败：{error}"))?;
        let mut status=shared.lock().unwrap_or_else(|p|p.into_inner());status.generation+=1;status.checking=false;
        if let Ok(value)=&result {publish(&mut status,value.clone());} else {status.at=None;}
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os="macos")]
    #[test]
    fn status_reads_keep_returning_cached_approval_while_one_query_is_pending() {
        let shared=state();
        {let mut status=shared.lock().unwrap();status.client=None;status.value=Some(json!({"ok":true,"status":"enabled"}));status.checking=true;}
        for _ in 0..100 {let reply=cached_status(None);assert_eq!(reply["status"],"enabled");assert_eq!(reply["checking"],true);}
        shared.lock().unwrap().checking=false;
    }
    #[test]
    fn transient_failures_keep_the_last_authorization_but_not_a_confirmed_uninstall() {
        let mut state=Status::default();publish(&mut state,json!({"ok":true,"status":"enabled"}));
        publish(&mut state,json!({"ok":false,"status":"unreachable","message":"temporary"}));
        assert_eq!(state.value.as_ref().unwrap()["status"],"enabled");assert_eq!(state.value.as_ref().unwrap()["warning"],"temporary");
        publish(&mut state,json!({"status":"notRegistered"}));assert_eq!(state.value.as_ref().unwrap()["status"],"notRegistered");
    }
}
