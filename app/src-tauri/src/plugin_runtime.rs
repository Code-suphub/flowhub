//! Generic native plugin runtime: local packages, static assets and JSON-line RPC.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path,PathBuf}, sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}}};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt,AsyncWriteExt};
use tauri_plugin_dialog::DialogExt;
mod sources;

#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct Manifest { schema:u32, id:String, name:String, version:String, ui:String, executable:String, permissions:Vec<String>, #[serde(default)] description:String, #[serde(default,rename="statusSurface")] status_surface:bool }
#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct Installed { manifest:Manifest, directory:PathBuf, enabled:bool }
pub(crate) struct Runtime { root:PathBuf, installed:Mutex<Vec<Installed>>, sessions:tokio::sync::Mutex<HashMap<String,Arc<Session>>>,sources:Mutex<Vec<sources::Source>>,candidates:Mutex<HashMap<String,sources::Candidate>> }
struct Session { child:tokio::sync::Mutex<tokio::process::Child>, input:tokio::sync::Mutex<tokio::process::ChildStdin>, pending:Arc<Mutex<HashMap<u64,tokio::sync::oneshot::Sender<Result<Value,String>>>>>, sequence:AtomicU64 }
fn safe_id(id:&str)->bool { !id.is_empty() && id.len()<=80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'-' || c==b'_') }
fn inside(root:&Path, relative:&str)->Result<PathBuf,String> {
    let relative=Path::new(relative);
    if relative.components().any(|c| !matches!(c,std::path::Component::Normal(_))) { return Err("插件路径必须是包内相对路径".into()); }
    let path=root.join(relative).canonicalize().map_err(|e|e.to_string())?;
    if !path.starts_with(root) || !path.is_file() { return Err("插件文件越出包目录".into()); } Ok(path)
}
fn package(directory:PathBuf)->Result<Installed,String> {
    let directory=directory.canonicalize().map_err(|e|e.to_string())?;
    let manifest:Manifest=serde_json::from_slice(&std::fs::read(directory.join("flowhub-plugin.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if manifest.schema!=2 || !safe_id(&manifest.id) || manifest.permissions!=["native-process"] { return Err("不支持的插件协议或权限".into()); }
    semver::Version::parse(&manifest.version).map_err(|e|e.to_string())?;
    inside(&directory,&manifest.ui)?; inside(&directory,&manifest.executable)?;
    Ok(Installed{manifest,directory,enabled:true})
}
impl Runtime {
    pub(crate) fn status_plugins(&self)->Vec<(String,String)> { self.installed.lock().unwrap().iter().filter(|p|p.enabled && p.manifest.status_surface).map(|p|(p.manifest.id.clone(),p.manifest.name.clone())).collect() }
    pub(crate) async fn status_snapshot(&self,id:&str)->Result<Value,String> {
        if !self.get(id)?.manifest.status_surface {return Err("插件未提供状态组件".into());}
        self.session(id).await?.call("status_snapshot".into(),json!({})).await
    }
    pub(crate) fn new(root:PathBuf)->Result<Self,String> {
        let installed=match std::fs::read(root.join("plugins.json")) { Ok(data)=>serde_json::from_slice(&data).map_err(|e|format!("插件清单损坏：{e}"))?, Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Vec::new(),Err(e)=>return Err(e.to_string()) };
        let sources=sources::load(&root)?;
        Ok(Self{root,installed:Mutex::new(installed),sessions:tokio::sync::Mutex::new(HashMap::new()),sources:Mutex::new(sources),candidates:Mutex::new(HashMap::new())})
    }
    fn list(&self)->Value { json!(self.installed.lock().unwrap().clone()) }
    fn update(&self, f:impl FnOnce(&mut Vec<Installed>))->Result<Value,String> {
        let mut installed=self.installed.lock().unwrap();let mut next=installed.clone();f(&mut next);
        crate::storage::write_json_atomic(&self.root.join("plugins.json"),&json!(next))?;*installed=next;Ok(json!(*installed))
    }
    fn get(&self,id:&str)->Result<Installed,String> { self.installed.lock().unwrap().iter().find(|p|p.manifest.id==id && p.enabled).cloned().ok_or("插件未安装或已停用".into()) }
    async fn stop(&self,id:&str) {
        if let Some(session)=self.sessions.lock().await.remove(id) { let mut child=session.child.lock().await;let _=child.kill().await;let _=child.wait().await; }
    }
    async fn session(&self,id:&str)->Result<Arc<Session>,String> {
        let mut sessions=self.sessions.lock().await;
        if let Some(session)=sessions.get(id) {
            if session.child.lock().await.try_wait().map_err(|e|e.to_string())?.is_none(){return Ok(session.clone());}
        }
        let p=self.get(id)?;let executable=inside(&p.directory,&p.manifest.executable)?;
        let data=self.root.join(id);
        std::fs::create_dir_all(&data).map_err(|e|e.to_string())?;
        let mut child=tokio::process::Command::new(executable).current_dir(&p.directory).env("FLOWHUB_PLUGIN_DATA",data)
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().map_err(|e|format!("启动插件失败：{e}"))?;
        let input=child.stdin.take().ok_or("缺少插件输入")?;let output=child.stdout.take().ok_or("缺少插件输出")?;
        let pending:Arc<Mutex<HashMap<u64,tokio::sync::oneshot::Sender<Result<Value,String>>>>>=Arc::new(Mutex::new(HashMap::new()));
        let requests=pending.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines=tokio::io::BufReader::new(output).lines();
            while let Ok(Some(line))=lines.next_line().await {
                if line.len()>4*1024*1024 {break;}
                if let Ok(value)=serde_json::from_str::<Value>(&line) {
                    if let Some(id)=value["id"].as_u64() { if let Some(sender)=requests.lock().unwrap().remove(&id) {
                        let _=sender.send(if let Some(error)=value["error"].as_str(){Err(error.into())}else{Ok(value["result"].clone())});
                    }}
                }
            }
            for (_,sender) in requests.lock().unwrap().drain(){let _=sender.send(Err("插件进程已退出，请重新加载".into()));}
        });
        let session=Arc::new(Session{child:tokio::sync::Mutex::new(child),input:tokio::sync::Mutex::new(input),pending,sequence:AtomicU64::new(1)});
        sessions.insert(id.into(),session.clone());Ok(session)
    }
    pub(crate) fn asset(&self,id:&str,path:&str)->Result<(Vec<u8>,&'static str),String> {
        let p=self.get(id)?;let ui=inside(&p.directory,&p.manifest.ui)?;let root=ui.parent().ok_or("缺少页面目录")?;
        let file=inside(root,path)?;
        let mime=match file.extension().and_then(|s|s.to_str()).unwrap_or(""){"html"=>"text/html; charset=utf-8","js"=>"text/javascript; charset=utf-8","css"=>"text/css; charset=utf-8","svg"=>"image/svg+xml","png"=>"image/png",_=>return Err("不支持的插件资源".into())};
        let data=std::fs::read(file).map_err(|e|e.to_string())?;if data.len()>8*1024*1024{return Err("插件资源过大".into());} Ok((data,mime))
    }
}
impl Session {
    async fn call(&self,method:String,params:Value)->Result<Value,String>{
        let id=self.sequence.fetch_add(1,Ordering::Relaxed);let (tx,rx)=tokio::sync::oneshot::channel();
        {let mut pending=self.pending.lock().unwrap();if pending.len()>=64{return Err("插件请求过多".into());}pending.insert(id,tx);}
        let message=format!("{}\n",json!({"id":id,"method":method,"params":params}));
        let write=self.input.lock().await.write_all(message.as_bytes()).await;
        if let Err(error)=write{self.pending.lock().unwrap().remove(&id);return Err(error.to_string());}
        let result=tokio::time::timeout(std::time::Duration::from_secs(120),rx).await;
        self.pending.lock().unwrap().remove(&id);
        result.map_err(|_|"插件请求超时".to_string())?.map_err(|_|"插件连接已关闭".to_string())?
    }
}
pub(crate) fn asset_csp(id: &str) -> String {
    // Only the selected package may supply executable assets; never allow the
    // host's tauri origin or arbitrary network resources into the sandbox.
    let source = if !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        format!("flowhub-plugin://{id}")
    } else { "'none'".into() };
    format!("default-src 'none'; script-src {source}; style-src {source} 'unsafe-inline'; img-src {source} data:; font-src {source}; connect-src 'none'; base-uri 'none'; form-action 'none'")
}
fn trusted(window:&tauri::WebviewWindow)->Result<(),String>{if window.label()=="settings"{Ok(())}else{Err("仅设置窗口可管理插件".into())}}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sandbox_assets_use_explicit_package_origin() {
        let csp = asset_csp("machines");
        assert!(csp.contains("script-src flowhub-plugin://machines;"));
        assert!(csp.contains("style-src flowhub-plugin://machines 'unsafe-inline';"));
        assert!(!csp.contains("'self'"));
        assert!(!asset_csp("bad; script-src *").contains('*'));
    }
    #[tokio::test]
    async fn package_paths_process_restart_and_registration() {
        use std::os::unix::fs::{PermissionsExt,symlink};
        let root=std::env::temp_dir().join(format!("flowhub-plugins-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let package_root=root.join("package");std::fs::create_dir_all(package_root.join("ui")).unwrap();
        std::fs::write(package_root.join("ui/index.html"),"<h1>Plugin</h1>").unwrap();
        std::fs::write(package_root.join("service"),"#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' '{\"id\":1,\"result\":{\"protocol\":1}}'; done\n").unwrap();
        std::fs::set_permissions(package_root.join("service"),std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(package_root.join("flowhub-plugin.json"),json!({"schema":2,"id":"test-plugin","name":"Test","version":"1.0.0","ui":"ui/index.html","executable":"service","permissions":["native-process"]}).to_string()).unwrap();
        let p=package(package_root.clone()).unwrap();let rt=Runtime::new(root.clone()).unwrap();rt.update(|list|list.push(p)).unwrap();
        assert!(rt.asset("test-plugin","../service").is_err());
        symlink(package_root.join("service"),package_root.join("ui/escape.js")).unwrap();
        assert!(rt.asset("test-plugin","escape.js").is_err());
        assert_eq!(rt.asset("test-plugin","index.html").unwrap().0,b"<h1>Plugin</h1>");
        let first=rt.session("test-plugin").await.unwrap();
        assert_eq!(first.call("health".into(),json!({})).await.unwrap()["protocol"],1);
        rt.stop("test-plugin").await;
        let second=rt.session("test-plugin").await.unwrap();assert!(!Arc::ptr_eq(&first,&second));
        assert_eq!(second.call("health".into(),json!({})).await.unwrap()["protocol"],1);
        rt.stop("test-plugin").await;
        assert_eq!(Runtime::new(root.clone()).unwrap().list().as_array().unwrap().len(),1);
        drop(first);drop(second);drop(rt);std::fs::remove_dir_all(root).unwrap();
    }
}
#[tauri::command]
pub(crate) async fn plugin_rpc(window:tauri::WebviewWindow,app:tauri::AppHandle,id:String,method:String,params:Value)->Result<Value,String>{
    trusted(&window)?;let rt=app.state::<Runtime>();rt.session(&id).await?.call(method,params).await
}
#[tauri::command]
pub(crate) async fn plugin_api(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String,payload:Value)->Result<Value,String>{
    trusted(&window)?;let rt=app.state::<Runtime>();let id=payload["id"].as_str().unwrap_or("");
    match action.as_str(){
        "sources"|"saveSource"|"removeSource"|"chooseSource"|"scanSource"|"installCandidate"=>sources::api(&rt,&app,&action,&payload).await,
        "list"=>Ok(rt.list()),
        "choose"=>{let (tx,rx)=tokio::sync::oneshot::channel();app.dialog().file().set_title("选择独立插件目录").pick_folder(move |p|{let _=tx.send(p);});
            match rx.await.map_err(|e|e.to_string())?{Some(p)=>Ok(json!(package(p.into_path().map_err(|e|e.to_string())?)?)),None=>Ok(Value::Null)}},
        "inspect"=>Ok(json!(package(PathBuf::from(payload["directory"].as_str().ok_or("缺少插件目录")?))?)),
        "install"=>{let p=package(PathBuf::from(payload["directory"].as_str().ok_or("缺少插件目录")?))?;rt.stop(&p.manifest.id).await;rt.update(|items|{items.retain(|old|old.manifest.id!=p.manifest.id);items.push(p);})},
        "reload"=>{let old=rt.get(id)?;let p=package(old.directory)?;if p.manifest.id!=id{return Err("插件 ID 已变化，请重新安装".into());}rt.stop(id).await;rt.update(|items|{items.retain(|old|old.manifest.id!=id);items.push(p);})?;rt.session(id).await?.call("health".into(),json!({})).await?;Ok(rt.list())},
        "enable"=>{let enabled=payload["enabled"].as_bool().ok_or("缺少 enabled")?;if !enabled{rt.stop(id).await;}rt.update(|items|{for p in items {if p.manifest.id==id{p.enabled=enabled;}}})},
        "uninstall"=>{rt.stop(id).await;rt.update(|items|items.retain(|p|p.manifest.id!=id))},
        _=>Err("未知插件管理操作".into())
    }
}
