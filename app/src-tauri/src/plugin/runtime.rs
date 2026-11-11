//! Generic native plugin runtime: local packages, static assets and JSON-line RPC.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path,PathBuf}, sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}}};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt,AsyncWriteExt};
use tauri_plugin_dialog::DialogExt;
mod sources;
mod applications;
mod mail;
mod privileged_monitor;
#[cfg(target_os = "macos")]
pub(crate) mod cli;

#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct Manifest { schema:u32, id:String, name:String, version:String, ui:String, executable:String, permissions:Vec<String>, #[serde(default)] description:String, #[serde(default)] searchable:bool, #[serde(default,rename="statusSurface")] status_surface:bool, #[serde(default,skip_serializing_if="Option::is_none")] widget:Option<WidgetDefinition> }
#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct WidgetDefinition { pub card:String, pub editor:String, pub detail:String, #[serde(default,rename="minWidth",skip_serializing_if="Option::is_none")] pub min_width:Option<u32>, #[serde(default,rename="minHeight",skip_serializing_if="Option::is_none")] pub min_height:Option<u32>, #[serde(default,skip_serializing_if="is_false")] pub interactive:bool }
fn is_false(value:&bool)->bool{!*value}
#[derive(Clone,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="lowercase")]
enum InstallOrigin { Directory, Market { #[serde(default,skip_serializing_if="Option::is_none")] source:Option<String> } }
#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct Installed { manifest:Manifest, directory:PathBuf, enabled:bool, #[serde(default,rename="lastLoadedAt",skip_serializing_if="Option::is_none")] last_loaded_at:Option<i64>, #[serde(default,skip_serializing_if="Option::is_none")] origin:Option<InstallOrigin> }
pub(crate) struct Runtime { root:PathBuf, installed:Mutex<Vec<Installed>>, sessions:tokio::sync::Mutex<HashMap<String,Arc<Session>>>,sources:Mutex<Vec<sources::Source>>,candidates:Mutex<HashMap<String,sources::Candidate>>,package_lock:tokio::sync::Mutex<()>,mail:Arc<Mutex<Option<mail::Monitor>>> }
struct Session { child:tokio::sync::Mutex<tokio::process::Child>, input:tokio::sync::Mutex<tokio::process::ChildStdin>, pending:Arc<Mutex<HashMap<u64,tokio::sync::oneshot::Sender<Result<Value,String>>>>>, sequence:AtomicU64 }
fn safe_id(id:&str)->bool { !id.is_empty() && id.len()<=80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'-' || c==b'_') }
fn mail_allowed(plugin:&Installed)->bool {
    plugin.enabled && plugin.manifest.id=="twofa" && plugin.manifest.permissions.iter().any(|p|p=="mail-read")
}
fn valid_permissions(id:&str, permissions:&[String])->bool {
    permissions==["native-process"] || (id=="twofa" && permissions==["native-process","mail-read"]) || (id=="resource-monitor" && (2..=4).contains(&permissions.len()) && permissions.iter().any(|p|p=="native-process") && permissions.iter().any(|p|p=="system-process-monitor") && permissions.iter().all(|p|matches!(p.as_str(),"native-process"|"system-process-monitor"|"system-process-control"|"system-service-control")) && (!permissions.iter().any(|p|p=="system-service-control")||permissions.iter().any(|p|p=="system-process-control")) && permissions.iter().collect::<std::collections::HashSet<_>>().len()==permissions.len())
}
fn inside(root:&Path, relative:&str)->Result<PathBuf,String> {
    let relative=Path::new(relative);
    if relative.components().any(|c| !matches!(c,std::path::Component::Normal(_))) { return Err("插件路径必须是包内相对路径".into()); }
    let path=root.join(relative).canonicalize().map_err(|e|e.to_string())?;
    if !path.starts_with(root) || !path.is_file() { return Err("插件文件越出包目录".into()); } Ok(path)
}
fn package(directory:PathBuf)->Result<Installed,String> {
    let directory=directory.canonicalize().map_err(|e|e.to_string())?;
    let manifest:Manifest=serde_json::from_slice(&std::fs::read(directory.join("flowhub-plugin.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if manifest.schema!=2 || !safe_id(&manifest.id) || !valid_permissions(&manifest.id,&manifest.permissions) { return Err("不支持的插件协议或权限".into()); }
    semver::Version::parse(&manifest.version).map_err(|e|e.to_string())?;
    inside(&directory,&manifest.ui)?; inside(&directory,&manifest.executable)?;
    if let Some(widget)=&manifest.widget {let ui=inside(&directory,&manifest.ui)?;let root=ui.parent().ok_or("缺少插件页面目录")?;for page in [&widget.card,&widget.editor,&widget.detail]{if !page.ends_with(".html"){return Err("组件入口必须为 HTML 页面".into());}inside(root,page)?;}}
    Ok(Installed{manifest,directory,enabled:true,last_loaded_at:None,origin:Some(InstallOrigin::Directory)})
}
impl Runtime {
    pub(crate) async fn sync_mail_monitor(&self) {
        let _packages = self.package_lock.lock().await;
        self.sync_mail_monitor_locked().await;
    }

    async fn sync_mail_monitor_locked(&self) {
        let enabled = self.get("twofa").is_ok_and(|p|mail_allowed(&p));
        let monitor = self.mail.clone();
        let root = self.root.join("twofa");
        let _ = tokio::task::spawn_blocking(move || {
            let mut monitor = monitor.lock().unwrap();
            if enabled {
                monitor.get_or_insert_with(|| mail::Monitor::new(&root));
            } else {
                *monitor = None;
            }
        }).await;
    }

    fn read_mail<T>(&self, read:impl FnOnce(&mail::Monitor)->Result<T,String>) -> Result<T,String> {
        if !mail_allowed(&self.get("twofa")?) {
            return Err("当前插件版本未声明邮件读取权限".into());
        }
        let guard = self.mail.try_lock().map_err(|_|"正在处理邮箱授权，请稍后再试")?;
        read(guard.as_ref().ok_or("正在启动邮件监控，请稍后再试")?)
    }

    async fn change_mail(&self, method:String, params:Value) -> Result<Value,String> {
        if !mail_allowed(&self.get("twofa")?) {
            return Err("当前插件版本未声明邮件读取权限".into());
        }
        let monitor = self.mail.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = monitor.try_lock().map_err(|_|"正在处理邮箱授权，请稍后再试")?;
            let monitor = guard.as_mut().ok_or("正在启动邮件监控，请稍后再试")?;
            match method.as_str() {
                "mail_add" => monitor.add(params),
                "mail_remove" => monitor.remove(&params),
                _ => Err("不支持的邮箱操作".into()),
            }
        }).await.map_err(|_|"邮箱授权操作失败")?
    }

    async fn search_codes(&self, mut params:Value) -> Result<Value,String> {
        let query = params["query"].as_str().unwrap_or("").trim().to_lowercase();
        let limit = params["limit"].as_u64().unwrap_or(12).min(50) as usize;
        let offset = params["offset"].as_u64().unwrap_or(0) as usize;
        let matches = self.read_mail(|monitor| Ok(if params["includeMailAccounts"] == true {
            monitor.search_accounts(&query)
        } else {
            monitor.search(&query)
        }));
        let mail_only = mail::is_mail_only(&query);
        let matches = if mail_only { matches? } else { matches.unwrap_or_default() };
        let mail_count = matches.len();
        let mut rows = matches.into_iter().skip(offset).take(limit).collect::<Vec<_>>();
        if !mail_only && rows.len() < limit {
            params = json!({"query":query,"offset":offset.saturating_sub(mail_count),"limit":limit-rows.len()});
            match self.session("twofa").await?.call("search".into(),params).await {
                Ok(Value::Array(totp)) => rows.extend(totp.into_iter().take(limit-rows.len())),
                Ok(_) => return Err("验证码搜索结果无效".into()),
                Err(error) if rows.is_empty() => return Err(error),
                Err(_) => {}
            }
        }
        Ok(Value::Array(rows))
    }

    async fn verification_code(&self, params: &Value) -> Result<(String, u64), String> {
        if params["source"] == "mail" {
            return self.read_mail(|monitor| monitor.code(params["id"].as_str().unwrap_or("")));
        }
        let result = self.session("twofa").await?
            .call("activate".into(), json!({"name": params["name"]})).await?;
        let code = result["code"].as_str().ok_or("验证码不可用")?.to_owned();
        let remaining = result["remaining"].as_u64().unwrap_or(0).min(300);
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        let mut expires_at = now + remaining;
        if let Some(period) = result["period"].as_u64().filter(|&p| remaining > 0 && remaining <= p) {
            // TOTP changes on a period boundary. Round down to absorb IPC delay.
            expires_at -= expires_at % period;
        }
        Ok((code, expires_at * 1000))
    }

    async fn activate_code(&self, app: tauri::AppHandle, params: &Value, paste: Option<crate::clipboard::PasteRequest>) -> Result<Value,String> {
        let (code, _) = self.verification_code(params).await?;
        crate::clipboard::activate_private_code(app,code,paste).await
    }

    #[cfg(feature = "ui-test")]
    pub(crate) fn install_ui_test_fixture(&self, directory: PathBuf) -> Result<(), String> {
        let fixture = package(directory)?;
        self.update(|items| { items.retain(|p| p.manifest.id != fixture.manifest.id); items.push(fixture); })?;
        Ok(())
    }
    pub(crate) fn has_launcher_entry(&self,id:&str)->bool { self.get(id).is_ok() }
    fn launcher_entries(&self)->Value { Value::Array(self.installed.lock().unwrap().iter().filter_map(launcher_entry).collect()) }
    pub(crate) async fn application_metadata(&self,app:&tauri::AppHandle,id:&str,params:&Value)->Result<Value,String>{
        self.get(id)?;
        if id!="resource-monitor" {return Err("此插件未提供应用监控能力".into());}
        applications::metadata(app.clone(),params).await
    }
    pub(crate) fn widget(&self,id:&str)->Result<WidgetDefinition,String>{let p=self.get(id)?;package(p.directory)?.manifest.widget.ok_or_else(||"请升级插件以支持独立桌面组件".to_string())}
    pub(crate) async fn widget_call(&self,window:&tauri::WebviewWindow,id:&str,params:Value)->Result<Value,String>{
        self.widget(id)?;
        if params.to_string().len()>65536{return Err("组件请求过大".into());}
        if params["action"]=="management" {
            let method=params["method"].as_str().unwrap_or("");
            if super::script_observer::handles(method){
                if id!="resource-monitor" {return Err("此插件未提供脚本观察能力".into());}
                return super::script_observer::call(window,method,&params["params"]).await;
            }
            let action=match params["method"].as_str().unwrap_or("") {
                "privileged_status"=>Some("status"),
                "privileged_enable"=>Some("enable"),
                "privileged_disable"=>Some("disable"),
                _=>None,
            };
            if let Some(action)=action {
                let plugin=self.get(id)?;
                if !plugin.manifest.permissions.iter().any(|permission|permission=="system-process-monitor") {
                    return Err("已安装的插件版本未声明系统进程监控授权能力；请重新安装插件并确认该权限。".into());
                }
                let client=if plugin.manifest.permissions.iter().any(|p|p=="system-process-control") {Some(inside(&plugin.directory,&plugin.manifest.executable)?)} else {None};
                return privileged_monitor::invoke(action,client,plugin.manifest.permissions.iter().any(|p|p=="system-service-control")).await;
            }
        }
        self.session(id).await?.call("widget_api".into(),params).await
    }
    pub(crate) fn status_plugins(&self)->Vec<(String,String)> { self.installed.lock().unwrap().iter().filter(|p|p.enabled && p.manifest.status_surface).map(|p|(p.manifest.id.clone(),p.manifest.name.clone())).collect() }
    pub(crate) fn widget_plugins(&self)->Vec<(String,String)> {
        let installed=self.installed.lock().unwrap().clone();
        installed.into_iter().filter(|p|p.enabled).filter_map(|p|{
            let manifest=package(p.directory).ok()?.manifest;
            manifest.widget.as_ref()?;
            Some((manifest.id,manifest.name))
        }).collect()
    }
    pub(crate) async fn status_snapshot(&self,id:&str)->Result<Value,String> {
        if !self.get(id)?.manifest.status_surface {return Err("插件未提供状态组件".into());}
        self.session(id).await?.call("status_snapshot".into(),json!({})).await
    }
    pub(crate) fn new(root:PathBuf)->Result<Self,String> {
        let installed=match std::fs::read(root.join("plugins.json")) { Ok(data)=>serde_json::from_slice(&data).map_err(|e|format!("插件清单损坏：{e}"))?, Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Vec::new(),Err(e)=>return Err(e.to_string()) };
        let sources=sources::load(&root)?;
        Ok(Self{root,installed:Mutex::new(installed),sessions:tokio::sync::Mutex::new(HashMap::new()),sources:Mutex::new(sources),candidates:Mutex::new(HashMap::new()),package_lock:tokio::sync::Mutex::new(()),mail:Arc::new(Mutex::new(None))})
    }
    pub(crate) fn loaded_at(&self,id:&str)->Option<i64>{self.get(id).ok().and_then(|p|p.last_loaded_at)}
    fn list(&self)->Value {
        let managed=self.root.join("plugin-packages");let managed=managed.canonicalize().unwrap_or(managed);
        let mut installed=self.installed.lock().unwrap().clone();
        for p in &mut installed {if p.origin.is_none(){p.origin=Some(if p.directory.starts_with(&managed){InstallOrigin::Market{source:None}}else{InstallOrigin::Directory});}}
        json!(installed)
    }
    fn update(&self, f:impl FnOnce(&mut Vec<Installed>))->Result<Value,String> {
        let mut installed=self.installed.lock().unwrap();let mut next=installed.clone();f(&mut next);
        crate::storage::write_json_atomic(&self.root.join("plugins.json"),&json!(next))?;*installed=next;Ok(json!(*installed))
    }
    fn registered(&self,id:&str)->Result<Installed,String> { self.installed.lock().unwrap().iter().find(|p|p.manifest.id==id).cloned().ok_or("插件未安装".into()) }
    fn get(&self,id:&str)->Result<Installed,String> { self.registered(id).and_then(|p|if p.enabled{Ok(p)}else{Err("插件已停用".into())}) }
    async fn reload(&self,id:&str,params:&Value)->Result<Value,String> {
        let old=self.registered(id)?;
        let mut next=package(old.directory.clone())?;
        if next.manifest.id!=id{return Err("插件 ID 已变化，未更新当前插件".into());}
        if let Some(expected)=params.get("expectedManifest") {
            if expected!=&json!(next.manifest){return Err("目录内容已变化，请重新点击“更新”核对版本".into());}
        }
        if next.manifest.permissions.iter().any(|p|!old.manifest.permissions.contains(p)) && params["confirmedPermissions"]!=json!(next.manifest.permissions) {
            return Err("插件新增运行权限，请先核对并确认".into());
        }
        next.enabled=old.enabled;
        next.origin=old.origin;
        next.last_loaded_at=if old.enabled{Some(chrono::Utc::now().timestamp_millis().max(old.last_loaded_at.unwrap_or(0).saturating_add(1)))}else{old.last_loaded_at};
        self.stop(id).await;
        self.update(|items|{if let Some(item)=items.iter_mut().find(|p|p.manifest.id==id){*item=next;}})?;
        if id=="twofa"{self.sync_mail_monitor_locked().await;}
        if old.enabled{self.session(id).await?.call("health".into(),json!({})).await.map_err(|e|format!("目录已更新，但插件启动检查失败：{e}"))?;}
        Ok(self.list())
    }
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
        if path=="__flowhub_widget_lifecycle.js" {return Ok((include_bytes!("../../../ui/plugin/widget-lifecycle.js").to_vec(),"text/javascript; charset=utf-8"));}
        let file=inside(root,path)?;
        let mime=match file.extension().and_then(|s|s.to_str()).unwrap_or(""){"html"=>"text/html; charset=utf-8","js"=>"text/javascript; charset=utf-8","css"=>"text/css; charset=utf-8","svg"=>"image/svg+xml","png"=>"image/png",_=>return Err("不支持的插件资源".into())};
        let data=std::fs::read(file).map_err(|e|e.to_string())?;if data.len()>8*1024*1024{return Err("插件资源过大".into());}
        Ok((if mime.starts_with("text/html") {widget_lifecycle_html(data)}else{data},mime))
    }
}
fn widget_lifecycle_html(data:Vec<u8>)->Vec<u8> {
    let mut html=match String::from_utf8(data){Ok(html)=>html,Err(error)=>return error.into_bytes()};
    let lower=html.to_ascii_lowercase();
    let head=lower.match_indices("<head").find(|(index,_)|matches!(lower.as_bytes().get(index+5),Some(b'>')|Some(b' ')|Some(b'\t')|Some(b'\n')|Some(b'\r')))
        .and_then(|(index,_)|lower[index..].find('>').map(|end|index+end+1));
    let position=head.or_else(||lower.find("<!doctype").and_then(|index|lower[index..].find('>').map(|end|index+end+1))).unwrap_or(0);
    html.insert_str(position,"<script src=\"/__flowhub_widget_lifecycle.js\"></script>");html.into_bytes()
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
fn trusted(window:&tauri::WebviewWindow)->Result<(),String>{if matches!(window.label(),"settings"|"plugin-panel"){Ok(())}else{Err("仅宿主插件面板可管理插件".into())}}
fn launcher_entry(plugin:&Installed)->Option<Value> {
    plugin.enabled.then(||json!({"id":plugin.manifest.id,"name":plugin.manifest.name,"description":plugin.manifest.description}))
}
#[tauri::command]
pub(crate) fn launcher_plugin_entries(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<Value,String> {
    if window.label()!="main" {return Err("仅启动器可读取命令入口".into());}
    Ok(app.state::<Runtime>().launcher_entries())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_control_requires_the_resource_monitor_and_explicit_process_control() {
        let permissions=vec!["native-process".into(),"system-process-monitor".into(),"system-process-control".into(),"system-service-control".into()];
        assert!(valid_permissions("resource-monitor",&permissions));
        assert!(!valid_permissions("other-plugin",&permissions));
        assert!(!valid_permissions("resource-monitor",&vec!["native-process".into(),"system-process-monitor".into(),"system-service-control".into()]));
    }

    fn reload_fixture(id:&str,enabled:bool)->(PathBuf,PathBuf,Runtime) {
        use std::os::unix::fs::PermissionsExt;
        static SEQUENCE:AtomicU64=AtomicU64::new(0);
        let root=std::env::temp_dir().join(format!("flowhub-local-reload-{}-{}-{}",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().unwrap(),SEQUENCE.fetch_add(1,Ordering::Relaxed)));
        let directory=root.join("package");std::fs::create_dir_all(directory.join("ui")).unwrap();
        std::fs::write(directory.join("ui/index.html"),"<p>fixture</p>").unwrap();
        std::fs::write(directory.join("service"),"#!/bin/sh\nprintf 1 > \"$FLOWHUB_PLUGIN_DATA/started\"\nwhile IFS= read -r line; do printf '%s\\n' '{\"id\":1,\"result\":{\"protocol\":2}}'; done\n").unwrap();
        std::fs::set_permissions(directory.join("service"),std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(directory.join("flowhub-plugin.json"),json!({"schema":2,"id":id,"name":"Local","version":"1.0.0","ui":"ui/index.html","executable":"service","permissions":["native-process"]}).to_string()).unwrap();
        let mut installed=package(directory.clone()).unwrap();installed.enabled=enabled;
        let runtime=Runtime::new(root.clone()).unwrap();runtime.update(|items|items.push(installed)).unwrap();
        (root,directory,runtime)
    }
    fn set_fixture_manifest(directory:&Path,change:impl FnOnce(&mut Value))->Value {
        let file=directory.join("flowhub-plugin.json");let mut manifest:Value=serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();change(&mut manifest);
        std::fs::write(file,manifest.to_string()).unwrap();json!(package(directory.to_owned()).unwrap().manifest)
    }
    #[tokio::test]
    async fn mail_monitor_survives_plugin_reload_but_stops_when_disabled() {
        let (root, directory, rt) = reload_fixture("twofa", true);
        let mut manifest = set_fixture_manifest(&directory, |m| {
            m["permissions"] = json!(["native-process","mail-read"]);
        });
        rt.reload("twofa",&json!({"expectedManifest":manifest,"confirmedPermissions":["native-process","mail-read"]})).await.unwrap();
        assert_eq!(rt.read_mail(mail::Monitor::status).unwrap()["accounts"],json!([]));
        // Reloading an enabled plugin must not reread this file or replace the monitor.
        std::fs::write(root.join("twofa/mail-accounts.json"),b"invalid").unwrap();
        manifest = set_fixture_manifest(&directory, |m| m["version"]=json!("1.1.0"));
        rt.reload("twofa",&json!({"expectedManifest":manifest})).await.unwrap();
        assert_eq!(rt.read_mail(mail::Monitor::status).unwrap()["accounts"],json!([]));
        rt.update(|items|items[0].enabled=false).unwrap();
        rt.sync_mail_monitor().await;
        assert!(rt.mail.lock().unwrap().is_none());
        assert!(rt.read_mail(mail::Monitor::status).is_err());
        rt.update(|items|items[0].enabled=true).unwrap();
        rt.sync_mail_monitor().await;
        assert!(rt.read_mail(mail::Monitor::status).unwrap_err().contains("邮箱配置"));
        rt.stop("twofa").await;
        drop(rt);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn local_reload_restarts_original_package_and_same_version_changes_revision() {
        let(root,directory,rt)=reload_fixture("local",true);
        let first=rt.session("local").await.unwrap();first.call("health".into(),json!({})).await.unwrap();
        let expected=set_fixture_manifest(&directory,|m|m["version"]=json!("1.1.0"));
        std::fs::write(directory.join("service"),"#!/bin/sh\nprintf 2 > \"$FLOWHUB_PLUGIN_DATA/started\"\nwhile IFS= read -r line; do printf '%s\\n' '{\"id\":1,\"result\":{\"protocol\":2}}'; done\n").unwrap();
        rt.reload("local",&json!({"expectedManifest":expected})).await.unwrap();
        assert!(!Arc::ptr_eq(&first,&rt.session("local").await.unwrap()));
        assert_eq!(std::fs::read_to_string(root.join("local/started")).unwrap(),"2");
        assert_eq!(rt.registered("local").unwrap().manifest.version,"1.1.0");
        let revision=rt.loaded_at("local").unwrap();rt.reload("local",&json!({"expectedManifest":expected})).await.unwrap();
        assert!(rt.loaded_at("local").unwrap()>revision);
        assert_eq!(rt.registered("local").unwrap().directory,directory.canonicalize().unwrap());
        rt.stop("local").await;drop(first);drop(rt);std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn local_reload_preserves_disabled_state_and_never_starts_its_process() {
        let(root,directory,rt)=reload_fixture("local",false);
        let expected=set_fixture_manifest(&directory,|m|m["version"]=json!("1.1.0"));
        rt.reload("local",&json!({"expectedManifest":expected})).await.unwrap();
        let installed=rt.registered("local").unwrap();assert!(!installed.enabled);assert_eq!(installed.manifest.version,"1.1.0");assert_eq!(installed.last_loaded_at,None);
        assert!(rt.sessions.lock().await.is_empty());assert!(!root.join("local/started").exists());
        assert_eq!(Runtime::new(root.clone()).unwrap().list()[0]["enabled"],false);
        drop(rt);std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn local_reload_rejects_changed_identity_and_stale_review_without_stopping_current_process() {
        let(root,directory,rt)=reload_fixture("local",true);let first=rt.session("local").await.unwrap();
        let expected=set_fixture_manifest(&directory,|m|m["version"]=json!("1.1.0"));
        set_fixture_manifest(&directory,|m|m["id"]=json!("different"));
        assert!(rt.reload("local",&json!({"expectedManifest":expected})).await.unwrap_err().contains("ID 已变化"));
        set_fixture_manifest(&directory,|m|{m["id"]=json!("local");m["version"]=json!("1.2.0");});
        assert!(rt.reload("local",&json!({"expectedManifest":expected})).await.unwrap_err().contains("目录内容已变化"));
        assert!(Arc::ptr_eq(&first,&rt.session("local").await.unwrap()));assert_eq!(rt.registered("local").unwrap().manifest.version,"1.0.0");
        std::fs::remove_file(directory.join("flowhub-plugin.json")).unwrap();assert!(rt.reload("local",&json!({})).await.is_err());
        assert!(Arc::ptr_eq(&first,&rt.session("local").await.unwrap()));rt.stop("local").await;drop(first);drop(rt);std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn local_reload_requires_exact_confirmation_for_added_permissions() {
        let(root,directory,rt)=reload_fixture("resource-monitor",false);
        let expected=set_fixture_manifest(&directory,|m|m["permissions"]=json!(["native-process","system-process-monitor"]));
        assert!(rt.reload("resource-monitor",&json!({"expectedManifest":expected})).await.unwrap_err().contains("权限"));
        assert_eq!(rt.registered("resource-monitor").unwrap().manifest.permissions,vec!["native-process"]);
        rt.reload("resource-monitor",&json!({"expectedManifest":expected,"confirmedPermissions":["native-process","system-process-monitor"]})).await.unwrap();
        assert!(!rt.registered("resource-monitor").unwrap().enabled);drop(rt);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_install_origin_is_inferred_without_rewriting_registration() {
        let(root,_,rt)=reload_fixture("local",false);rt.update(|items|items[0].origin=None).unwrap();
        assert_eq!(rt.list()[0]["origin"],json!({"kind":"directory"}));
        let managed=root.join("plugin-packages/legacy-package");std::fs::create_dir_all(&managed).unwrap();
        rt.update(|items|items[0].directory=managed.canonicalize().unwrap()).unwrap();
        assert_eq!(rt.list()[0]["origin"],json!({"kind":"market"}));
        let persisted:Value=serde_json::from_slice(&std::fs::read(root.join("plugins.json")).unwrap()).unwrap();assert!(persisted[0]["origin"].is_null());
        drop(rt);std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn launcher_catalog_exposes_enabled_names_without_paths_or_permissions() {
        let mut plugin:Installed=serde_json::from_value(json!({"manifest":{"schema":2,"id":"example","name":"示例插件","version":"1.0.0","ui":"ui/index.html","executable":"bin/secret","permissions":["native-process"],"description":"测试"},"directory":"/private/plugin","enabled":true})).unwrap();
        assert_eq!(launcher_entry(&plugin),Some(json!({"id":"example","name":"示例插件","description":"测试"})));
        plugin.enabled=false;assert!(launcher_entry(&plugin).is_none());
    }
    #[test]
    fn widget_timer_bootstrap_precedes_package_scripts_and_preserves_doctype() {
        for html in ["<!DOCTYPE html><HTML><HEAD lang=\"zh\"><script src=\"app.js\"></script></HEAD></HTML>","<!doctype html><script src=\"app.js\"></script>","<script src=\"app.js\"></script>"] {
            let injected=String::from_utf8(widget_lifecycle_html(html.as_bytes().to_vec())).unwrap();
            assert!(injected.find("/__flowhub_widget_lifecycle.js").unwrap()<injected.find("app.js").unwrap());
            if html.starts_with("<!") {assert!(injected.starts_with(&html[..15]));}
        }
    }
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
        let manifest_path=package_root.join("flowhub-plugin.json");
        let mut manifest:Value=serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["widget"]=json!({"card":"index.html","editor":"index.html","detail":"index.html"});
        std::fs::write(&manifest_path,manifest.to_string()).unwrap();
        assert_eq!(rt.widget("test-plugin").unwrap().detail,"index.html");
        assert!(rt.status_plugins().is_empty());
        assert_eq!(rt.widget_plugins(),vec![("test-plugin".to_string(),"Test".to_string())]);
        rt.update(|list|list[0].enabled=false).unwrap();
        assert!(rt.widget_plugins().is_empty());
        rt.update(|list|list[0].enabled=true).unwrap();
        manifest["widget"]["detail"]=json!("../outside.html");
        std::fs::write(package_root.join("outside.html"),"outside").unwrap();
        std::fs::write(&manifest_path,manifest.to_string()).unwrap();
        assert!(rt.widget("test-plugin").is_err());
        manifest["widget"]["detail"]=json!("index.html");
        std::fs::write(&manifest_path,manifest.to_string()).unwrap();
        assert!(rt.asset("test-plugin","../service").is_err());
        symlink(package_root.join("service"),package_root.join("ui/escape.js")).unwrap();
        assert!(rt.asset("test-plugin","escape.js").is_err());
        assert_eq!(rt.asset("test-plugin","index.html").unwrap().0,widget_lifecycle_html(b"<h1>Plugin</h1>".to_vec()));
        assert_eq!(rt.asset("test-plugin","__flowhub_widget_lifecycle.js").unwrap().0,include_bytes!("../../../ui/plugin/widget-lifecycle.js"));
        assert!(rt.asset("missing","__flowhub_widget_lifecycle.js").is_err());
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
pub(crate) async fn plugin_search_call(window:tauri::WebviewWindow,app:tauri::AppHandle,id:String,method:String,params:Value)->Result<Value,String>{
    if window.label()!="main" { return Err("仅快速搜索可调用插件搜索".into()); }
    let rt=app.state::<Runtime>();
    let plugin=rt.get(&id)?;
    if !plugin.enabled || !plugin.manifest.searchable { return Err("插件未提供搜索能力".into()); }
    if id=="twofa" {
        if method=="activate" {
            let paste = (params["paste"] == true).then(crate::clipboard::PasteRequest::capture);
            return rt.activate_code(app.clone(),&params,paste).await;
        }
        if method=="search" { return rt.search_codes(params).await; }
        if method=="mail_history" {
            let account = params["accountId"].as_str().ok_or("邮箱不可用")?;
            return rt.read_mail(|monitor| monitor.history(account, params["currentCodeId"].as_str()));
        }
        if method=="preview" {
            let (code, expires_at) = rt.verification_code(&params).await?;
            if expires_at <= chrono::Utc::now().timestamp_millis().max(0) as u64 {
                return Err("验证码已过期".into());
            }
            return Ok(json!({"code": code, "expiresAt": expires_at}));
        }
        return Err("不支持的验证码搜索操作".into());
    }
    rt.session(&id).await?.call(method,params).await
}
#[tauri::command]
pub(crate) async fn plugin_rpc(window:tauri::WebviewWindow,app:tauri::AppHandle,id:String,method:String,params:Value)->Result<Value,String>{
    trusted(&window)?;
    if method.starts_with("mail_") {
        if id!="twofa" { return Err("此插件未提供邮箱验证码能力".into()); }
        let rt=app.state::<Runtime>();
        return match method.as_str() {
            "mail_status" => rt.read_mail(mail::Monitor::status),
            "mail_add"|"mail_remove" => rt.change_mail(method,params).await,
            "mail_copy" => rt.activate_code(app.clone(),&json!({"source":"mail","id":params["id"]}),None).await,
            _ => Err("不支持的邮箱操作".into()),
        };
    }
    if method=="application_metadata" {
        return app.state::<Runtime>().application_metadata(&app,&id,&params).await;
    }
    if id=="resource-monitor" {
        if super::script_observer::handles(&method){app.state::<Runtime>().get(&id)?;return super::script_observer::call(&window,&method,&params).await;}
        let action=match method.as_str(){"privileged_status"=>Some("status"),"privileged_enable"=>Some("enable"),"privileged_disable"=>Some("disable"),_=>None};
        if let Some(action)=action {
            let rt=app.state::<Runtime>();
            let plugin=rt.get(&id)?;
            if !plugin.manifest.permissions.iter().any(|permission|permission=="system-process-monitor") {
                return Err("已安装的插件版本未声明系统进程监控授权能力；请重新安装插件并确认该权限。".into());
            }
            let client=if plugin.manifest.permissions.iter().any(|p|p=="system-process-control") {Some(inside(&plugin.directory,&plugin.manifest.executable)?)} else {None};
                return privileged_monitor::invoke(action,client,plugin.manifest.permissions.iter().any(|p|p=="system-service-control")).await;
        }
    }
    let rt=app.state::<Runtime>();rt.session(&id).await?.call(method,params).await
}
#[tauri::command]
pub(crate) async fn plugin_api(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String,payload:Value)->Result<Value,String>{
    // The dock can read names, but cannot install, manage or execute plugins.
    if window.label()=="plugin-dock" && action=="list" {return Ok(app.state::<Runtime>().list());}
    trusted(&window)?;let rt=app.state::<Runtime>();let id=payload["id"].as_str().unwrap_or("");
    let _mutation=if matches!(action.as_str(),"installCandidate"|"install"|"reload"|"enable"|"uninstall"){Some(rt.package_lock.try_lock().map_err(|_|"其他插件操作尚未完成，请稍后重试")?)}else{None};
    let progress=if action=="installCandidate" && !payload["onProgress"].is_null(){
        let channel:tauri::ipc::JavaScriptChannelId=serde_json::from_value(payload["onProgress"].clone()).map_err(|_|"安装进度通道无效")?;
        Some(channel.channel_on::<_,Value>(window.as_ref().clone()))
    }else{None};
    match action.as_str(){
        "sources"|"saveSource"|"removeSource"|"chooseSource"|"scanSource"|"installCandidate"=>sources::api(&rt,&app,&action,&payload,progress.as_ref()).await,
        "list"=>Ok(rt.list()),
        "choose"=>{let (tx,rx)=tokio::sync::oneshot::channel();app.dialog().file().set_title("选择独立插件目录").pick_folder(move |p|{let _=tx.send(p);});
            match rx.await.map_err(|e|e.to_string())?{Some(p)=>Ok(json!(package(p.into_path().map_err(|e|e.to_string())?)?)),None=>Ok(Value::Null)}},
        "inspect"=>Ok(json!(package(PathBuf::from(payload["directory"].as_str().ok_or("缺少插件目录")?))?)),
        "install"=>{
            let directory=payload["directory"].as_str().ok_or("缺少插件目录")?;
            let mut next=package(PathBuf::from(directory))?;
            if let Ok(old)=rt.registered(&next.manifest.id){next.enabled=old.enabled;}
            rt.stop(&next.manifest.id).await;
            let twofa=next.manifest.id=="twofa";
            let result=rt.update(|items|{
                items.retain(|old|old.manifest.id!=next.manifest.id);
                items.push(next);
            })?;
            if twofa{rt.sync_mail_monitor_locked().await;}
            Ok(result)
        },
        "reload"=>{
            let result=rt.reload(id,&payload).await;
            for target in app.webview_windows().values().filter(|w|matches!(w.label(),"settings"|"plugin-panel"|"plugin-dock")) {
                let _=target.eval("window.FlowHubPluginIntegration?.refresh().catch(console.error)");
            }
            result
        },
        "enable"=>{
            let enabled=payload["enabled"].as_bool().ok_or("缺少 enabled")?;
            if !enabled{rt.stop(id).await;}
            let result=rt.update(|items|{
                if let Some(plugin)=items.iter_mut().find(|plugin|plugin.manifest.id==id){plugin.enabled=enabled;}
            })?;
            if id=="twofa"{rt.sync_mail_monitor_locked().await;}
            Ok(result)
        },
        "uninstall"=>{
            rt.stop(id).await;
            let result=rt.update(|items|items.retain(|p|p.manifest.id!=id))?;
            if id=="twofa"{rt.sync_mail_monitor_locked().await;}
            Ok(result)
        },
        _=>Err("未知插件管理操作".into())
    }
}
