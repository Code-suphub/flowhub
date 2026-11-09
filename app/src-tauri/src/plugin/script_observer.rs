//! System authentication windows and script clues. Optional keychain labels
//! yield only the displayed requester's app name.
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, path::PathBuf, sync::{Arc, Mutex, OnceLock}, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os="macos")]
#[path="script_observer/macos.rs"]
mod native;
#[cfg(target_os="macos")]
#[path="script_observer/keychain.rs"]
mod keychain;
const LIMIT:usize=64;
const RETAIN:u64=30*60*1000;
const ALERT:&str="script-source-alert";
const ALERT_DURATION_MS: u64 = 12_000;
const REPLAY_DURATION_MS: u64 = 60_000;
fn now()->u64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
#[derive(Clone,Debug,PartialEq,Eq,Serialize)]
pub(super) struct Identity {pub pid:i32,pub started:u64,pub executable:String,pub uid:u32}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Node {#[serde(flatten)]pub identity:Identity,pub name:String,pub app_path:Option<String>}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Source {pub name:String,pub app_path:String,pub evidence:String}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Script {
    pub id:String,pub process:Node,pub chain:Vec<Node>,pub source:Option<Source>,
    pub responsible:Option<Node>,
    pub chain_note:String,pub first_seen:u64,pub last_seen:u64,pub running:bool,
}
#[derive(Clone,Debug,PartialEq)]
pub(super) struct Window {pub id:u32,pub owner:Identity,pub center:Option<(f64,f64)>,pub request_app:Option<String>}
impl Window {fn key(&self)->String {format!("{}:{}:{}",self.id,self.owner.pid,self.owner.started)}}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
struct Observation {
    id:String,window_id:u32,owner:Identity,first_seen:u64,last_seen:u64,visible:bool,
    #[serde(skip)]
    center: Option<(f64, f64)>,
    request_app: Option<String>,
    // Frozen evidence from the beginning of this window episode. Later scripts
    // must not silently replace the candidate that was visible at that time.
    candidates:Vec<Script>,candidate_count:usize,
}
#[derive(Default)]
struct History {scripts:Vec<Script>,events:Vec<Observation>,active:HashMap<String,String>,serial:u64}
impl History {
    #[cfg(target_os="macos")]
    fn skip_keychain(&self, at: u64) -> HashSet<String> {
        self.active.iter().filter_map(|(key, id)| {
            self.events.iter().find(|event| &event.id == id)
                .filter(|event| event.request_app.is_some() || at.saturating_sub(event.first_seen) > 3_000)
                .map(|_| key.clone())
        }).collect()
    }
    fn prune(&mut self,at:u64){
        self.scripts.retain(|r|r.running||at.saturating_sub(r.last_seen)<=RETAIN);self.scripts.truncate(LIMIT);
        self.events.retain(|r|r.visible||at.saturating_sub(r.last_seen)<=RETAIN);self.events.truncate(LIMIT);
        let retained:HashSet<_>=self.events.iter().map(|e|e.id.as_str()).collect();self.active.retain(|_,id|retained.contains(id.as_str()));
    }
    fn pause(&mut self,at:u64){self.active.clear();for s in &mut self.scripts{s.running=false;}for e in &mut self.events{e.visible=false;}self.prune(at);}
    fn observe(&mut self,mut scripts:Vec<Script>,windows:Option<Vec<Window>>,at:u64)->Vec<Observation>{
        for record in &mut self.scripts {record.running=false;}
        for mut record in scripts.drain(..).take(LIMIT){
            if let Some(previous)=self.scripts.iter_mut().find(|s|s.id==record.id){
                record.first_seen=previous.first_seen;
                if record.source.is_none()&&previous.source.is_some(){record.source=previous.source.clone();record.chain=previous.chain.clone();record.chain_note="保留此前核验的启动链；当前父链已不完整。".into();}
                *previous=record;
            }else{self.scripts.push(record);}
        }
        self.scripts.sort_by_key(|s|(std::cmp::Reverse(s.running),std::cmp::Reverse(s.last_seen),std::cmp::Reverse(s.process.identity.started)));
        let mut fresh=vec![];
        if let Some(windows)=windows {
            let mut active=HashMap::new();
            for event in &mut self.events{event.visible=false;}
            for window in windows.into_iter().take(LIMIT){
                let key=window.key();
                if let Some(id)=self.active.get(&key){
                    if let Some(event)=self.events.iter_mut().find(|e|&e.id==id){
                        event.visible=true;event.last_seen=at;
                        if event.request_app.is_none() {event.request_app=window.request_app;}
                        active.insert(key,id.clone());continue;
                    }
                }
                self.serial+=1;
                let id=format!("auth-{:x}",Sha256::digest(format!("{key}:{at}:{}",self.serial)));
                let candidates:Vec<_>=self.scripts.iter().filter(|s|at.saturating_sub(s.last_seen)<=2000&&s.process.identity.started/1000<=at).cloned().collect();
                let event=Observation{id:id.clone(),window_id:window.id,owner:window.owner,first_seen:at,last_seen:at,visible:true,center:window.center,request_app:window.request_app,candidate_count:candidates.len(),candidates:candidates.into_iter().take(8).collect()};
                self.events.insert(0,event.clone());fresh.push(event);active.insert(key,id);
            }
            self.active=active;
        }
        self.prune(at);fresh
    }
}
struct Observer {enabled:bool,keychain_names:bool,available:bool,at:u64,revision:u64,generation:u64,error:Option<String>,history:History,path:PathBuf,alert:Option<Value>,alert_center:Option<(f64,f64)>,alert_until:u64,last_alert:u64}
static STATE:OnceLock<Arc<Mutex<Observer>>>=OnceLock::new();
fn snapshot(state:&Observer)->Value {json!({"supported":cfg!(target_os="macos"),"enabled":state.enabled,"keychainNames":state.keychain_names,"available":state.available,"at":state.at,"revision":state.revision,"interval":1,"retentionMinutes":30,"limit":LIMIT,"records":state.history.scripts,"observations":state.history.events.iter().map(|e|json!({"id":e.id,"windowId":e.window_id,"owner":e.owner,"firstSeen":e.first_seen,"lastSeen":e.last_seen,"visible":e.visible,"candidateCount":e.candidate_count,"requestApp":e.request_app})).collect::<Vec<_>>(),"error":state.error})}
pub(crate) fn handles(method:&str)->bool {matches!(method,"script_observer_status"|"script_observer_config"|"script_observer_event"|"script_observer_replay")}
pub(crate) async fn call(window: &tauri::WebviewWindow, method: &str, params: &Value) -> Result<Value, String> {
    if method == "script_observer_replay" {
        return replay(window, params).await;
    }
    let state=STATE.get().ok_or("自动观察尚未启动，请更新并重启 FlowHub。")?;
    let mut state=state.lock().unwrap_or_else(|p|p.into_inner());
    if method=="script_observer_event"{
        let id=params["id"].as_str().filter(|s|s.len()<=80).ok_or("观察记录标识无效")?;
        let event = state.history.events.iter().find(|event| event.id == id)
            .ok_or("观察记录已过期，请刷新近期记录。")?;
        let mut result = json!(event);
        result["canReplay"] = json!(cfg!(target_os = "macos"));
        return Ok(result);
    }else if method=="script_observer_config" {
        if params.get("enabled").is_none() && params.get("keychainNames").is_none() {return Err("观察开关无效".into());}
        let enabled=params.get("enabled").map(Value::as_bool).unwrap_or(Some(state.enabled)).ok_or("观察开关无效")?;
        let keychain_names=params.get("keychainNames").map(Value::as_bool).unwrap_or(Some(state.keychain_names)).ok_or("钥匙串来源开关无效")?;
        crate::storage::write_json_atomic(&state.path,&json!({"enabled":enabled,"keychainNames":keychain_names}))?;
        state.enabled=enabled;state.keychain_names=keychain_names;state.generation+=1;state.revision+=1;
        if !enabled{state.history.pause(now());state.alert=None;state.alert_until=0;}
    }else if method!="script_observer_status"{return Err("不支持的观察操作".into());}
    Ok(snapshot(&state))
}
async fn replay(window: &tauri::WebviewWindow, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_str().filter(|id| id.len() <= 80).ok_or("观察记录标识无效")?;
    let state = STATE.get().ok_or("自动观察尚未启动，请更新并重启 FlowHub。")?;
    let source = window.clone();
    let app = window.app_handle().clone();
    let handle = app.clone();
    let id = id.to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            {
                let mut state = state.lock().unwrap_or_else(|p| p.into_inner());
                if !state.enabled || !state.available {
                    return Err("请先开启自动观察".into());
                }
                let event = state.history.events.iter().find(|event| event.id == id)
                    .ok_or("观察记录已过期，请刷新近期记录。")?;
                state.alert = Some(alert_content(event, true));
                state.alert_center = None;
                state.alert_until = now() + REPLAY_DURATION_MS;
            }
            show_alert(&handle, Some(&source))?;
            Ok(json!({"shown": true}))
        })();
        let _ = send.send(result);
    }).map_err(|error| error.to_string())?;
    receive.await.map_err(|_| "提示窗口无法打开".to_string())?
}
fn alert_content(event: &Observation, preview: bool) -> Value {
    let mut names: Vec<_> = event.candidates.iter()
        .filter_map(|record| record.source.as_ref().map(|source| source.name.as_str()))
        .collect();
    names.sort_unstable();
    names.dedup();
    names.truncate(2);
    json!({"id": event.id, "sourceNames": names.join("、"), "requestApp":event.request_app, "preview": preview})
}
pub(crate) fn start(app:&tauri::AppHandle,root:PathBuf){
    let path=root.join("script-observer.json");
    let config=crate::storage::read_json(&path).unwrap_or_default();
    let enabled=config["enabled"].as_bool().unwrap_or(true);
    let keychain_names=config["keychainNames"].as_bool().unwrap_or(false);
    let state=Arc::new(Mutex::new(Observer{enabled,keychain_names,available:false,at:0,revision:0,generation:0,error:None,history:History::default(),path,alert:None,alert_center:None,alert_until:0,last_alert:0}));
    if STATE.set(state.clone()).is_err(){return;}
    let app=app.clone();
    // One worker with no overlapping scans. Keychain label lookup is optional
    // and bounded separately from process enumeration.
    std::thread::Builder::new().name("flowhub-script-observer".into()).spawn(move||loop{
        let at=now();
        let plugin=app.state::<super::runtime::Runtime>().has_launcher_entry("resource-monitor");
        let (enabled,generation)={let mut s=state.lock().unwrap_or_else(|p|p.into_inner());s.available=plugin;if !plugin||!s.enabled{s.history.pause(at);}(s.enabled&&plugin,s.generation)};
        let mut show=false;let mut hide=false;
        if enabled {
            #[cfg(target_os="macos")]
            let scan={
                let skip={let s=state.lock().unwrap_or_else(|p|p.into_inner());s.keychain_names.then(||s.history.skip_keychain(at))};
                native::scan(at,skip.as_ref())
            };
            #[cfg(not(target_os="macos"))]
            let scan=(None::<Vec<Script>>,None::<Vec<Window>>,Some("自动观察目前仅支持 macOS。".to_string()));
            let mut s=state.lock().unwrap_or_else(|p|p.into_inner());
            // An in-flight scan must not publish after the user switches off.
            if s.enabled&&s.available&&s.generation==generation {
                let (scripts,windows,error)=scan;
                        s.at=at;s.revision+=1;s.error=error;
                        let scripts=scripts.unwrap_or_else(||s.history.scripts.clone());
                        let events=s.history.observe(scripts,windows,at);
                        if let Some(event)=events.first(){
                            s.alert = Some(alert_content(event, false));
                            s.alert_center = event.center;
                            if at.saturating_sub(s.last_alert)>=10_000 {s.last_alert=at;s.alert_until=at+ALERT_DURATION_MS;show=true;}
                            else if at<s.alert_until{show=true;}
                        } else if at < s.alert_until {
                            let name=s.alert.as_ref().filter(|alert|alert["preview"]==false&&alert["requestApp"].is_null())
                                .and_then(|alert|s.history.events.iter().find(|event|alert["id"]==event.id))
                                .and_then(|event|event.request_app.clone());
                            if let (Some(alert),Some(name))=(&mut s.alert,name) {
                                alert["requestApp"]=json!(name);
                                show=true;
                            }
                        }
            }
        }
        {let s=state.lock().unwrap_or_else(|p|p.into_inner());if !s.enabled||!s.available||at>=s.alert_until{hide=true;}}
        if show {
            let allow=crate::storage::hydrated_config(&app.state::<crate::AppState>()).ok().is_some_and(|v|v.pointer("/core/notifications/enabled").and_then(Value::as_bool).unwrap_or(true));
            if allow {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = show_alert(&handle, None) {
                        eprintln!("[flowhub-script-observer] 无法显示认证提示: {error}");
                    }
                });
            }
        }else if hide {if let Some(w)=app.get_webview_window(ALERT){let _=w.close();}}
        std::thread::sleep(Duration::from_secs(1));
    }).ok();
}
fn show_alert(app: &tauri::AppHandle, source: Option<&tauri::WebviewWindow>) -> Result<(), String> {
    if !app.state::<super::runtime::Runtime>().has_launcher_entry("resource-monitor") {
        return Err("应用资源监控未启用".into());
    }
    let center = {
        let state = STATE.get().ok_or("观察未启动")?.lock().unwrap_or_else(|p| p.into_inner());
        if !state.enabled || now() >= state.alert_until {
            return Err("认证提示已失效".into());
        }
        state.alert_center
    };
    let window = if let Some(window) = app.get_webview_window(ALERT) {
        window.eval("window.dispatchEvent(new Event('flowhub:script-alert'))")
            .map_err(|error| error.to_string())?;
        window
    } else {
        WebviewWindowBuilder::new(app, ALERT, WebviewUrl::App("script-alert.html".into()))
            .title("FlowHub · 认证窗口")
            .decorations(false).resizable(false).skip_taskbar(true)
            .always_on_top(true).focused(false).focusable(false).visible(false)
            .visible_on_all_workspaces(true).accept_first_mouse(true)
            .inner_size(288., 96.).build().map_err(|error| error.to_string())?
    };
    #[cfg(target_os = "macos")]
    return native::present_alert(&window, source, center);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, center);
        window.show().map_err(|error| error.to_string())
    }
}
#[tauri::command]
pub(crate) async fn script_alert_api(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String)->Result<Value,String>{
    if window.label()!=ALERT{return Err("提示窗口来源无效".into());}
    let id={let s=STATE.get().ok_or("观察未启动")?.lock().unwrap_or_else(|p|p.into_inner());
        if action=="context"{return Ok(s.alert.clone().unwrap_or(Value::Null));}
        s.alert.as_ref().and_then(|v|v["id"].as_str()).map(String::from)
    };
    if action=="open" {
        super::canvas::open_script_sources(app.clone(),id.ok_or("观察记录已过期")?).await?;
    }else if action!="dismiss"{return Err("不支持的提示操作".into());}
    {let mut s=STATE.get().unwrap().lock().unwrap_or_else(|p|p.into_inner());s.alert_until=0;}
    window.close().map_err(|e|e.to_string())?;Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(id:u32,started:u64)->Window{Window{id,owner:Identity{pid:20,started,uid:501,executable:"/System/SecurityAgent".into()},center:None,request_app:None}}
    fn script(pid:i32,at:u64)->Script{let identity=Identity{pid,started:at*1000,uid:501,executable:"/usr/bin/osascript".into()};Script{id:format!("{pid}-{at}"),process:Node{identity,name:"osascript".into(),app_path:None},chain:vec![],source:None,responsible:None,chain_note:String::new(),first_seen:at,last_seen:at,running:true}}
    #[test]
    fn windows_are_episodes_not_sampling_notifications_and_pid_reuse_is_distinct(){
        let mut h=History::default();assert_eq!(h.observe(vec![script(3,100)],Some(vec![window(1,1)]),100).len(),1);
        assert!(h.observe(vec![script(3,100)],Some(vec![window(1,1)]),200).is_empty());
        assert!(h.observe(vec![],None,300).is_empty());assert!(h.events[0].visible,"unavailable window metadata is not proof of dismissal");
        assert_eq!(h.observe(vec![],Some(vec![window(1,2)]),400).len(),1);
        h.observe(vec![],Some(vec![]),500);assert_eq!(h.observe(vec![],Some(vec![window(1,2)]),600).len(),1);
    }
    #[test]
    fn evidence_is_frozen_bounded_and_expires_without_expanding_action_scope(){
        let mut h=History::default();h.observe(vec![script(1,100)],Some(vec![window(1,1)]),100);
        h.observe(vec![script(2,200)],Some(vec![window(1,1)]),200);assert_eq!(h.events[0].candidates[0].process.identity.pid,1);
        assert_eq!(alert_content(&h.events[0], false)["sourceNames"], "");
        for i in 2..150{h.observe(vec![script(i,i as u64)],Some(vec![window(i as u32,1)]),i as u64);}
        assert!(h.scripts.len()<=LIMIT&&h.events.len()<=LIMIT);
        h.observe(vec![],Some(vec![]),RETAIN+1000);assert!(h.scripts.is_empty()&&h.events.is_empty());
    }
    #[test]
    fn a_late_keychain_label_enriches_only_its_own_episode() {
        let mut history = History::default();
        let initial = window(1, 1);
        history.observe(vec![script(1, 100)], Some(vec![initial.clone()]), 100);
        let mut identified = initial.clone();
        identified.request_app = Some("Arc".into());
        assert!(history.observe(vec![], Some(vec![identified]), 1_100).is_empty());
        assert_eq!(alert_content(&history.events[0], false)["requestApp"], "Arc");
        assert_eq!(history.events[0].candidates.len(), 1);
        history.observe(vec![], Some(vec![window(1, 2)]), 2_100);
        assert!(history.events[0].request_app.is_none());
    }
}
