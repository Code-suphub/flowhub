//! Generic read-only status surfaces. Domain metrics stay in the plugin.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Preferences {
    tray: bool, desktop: bool, pinned: bool, favorites: Vec<String>,
    position: Option<(f64, f64)>,
}
impl Default for Preferences {
    fn default()->Self {Self{tray:true,desktop:false,pinned:false,favorites:vec![],position:None}}
}
pub(crate) struct State {
    path: PathBuf,
    preferences: Mutex<HashMap<String, Preferences>>,
    cache: Mutex<HashMap<String, Value>>,
    menus: Mutex<HashMap<String, String>>,
}
impl State {
    pub(crate) fn snapshot(&self,id:&str)->Option<Value>{self.cache.lock().unwrap().get(id).cloned()}
    pub(crate) fn new(root:&std::path::Path)->Result<Self,String> {
        let path=root.join("plugin-status.json");
        let preferences=match std::fs::read(&path) {
            Ok(data)=>serde_json::from_slice(&data).map_err(|e|format!("状态组件配置损坏：{e}"))?,
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>HashMap::new(),Err(e)=>return Err(e.to_string()),
        };
        Ok(Self{path,preferences:Mutex::new(preferences),cache:Mutex::new(HashMap::new()),menus:Mutex::new(HashMap::new())})
    }
    fn prefs(&self,id:&str)->Preferences {self.preferences.lock().unwrap().get(id).cloned().unwrap_or_default()}
    fn save(&self,id:&str,prefs:Preferences)->Result<(),String> {
        let mut entries=self.preferences.lock().unwrap();let mut next=entries.clone();next.insert(id.into(),prefs);
        crate::storage::write_json_atomic(&self.path,&json!(next))?;*entries=next;Ok(())
    }
}
fn label(id:&str)->String {format!("plugin-status-{id}")}
fn available(app:&tauri::AppHandle,id:&str)->bool {
    app.state::<crate::plugin_runtime::Runtime>().status_plugins().iter().any(|(key,_)|key==id)
}
pub(crate) fn open(app:&tauri::AppHandle,id:&str)->Result<(),String> {
    if !available(app,id){return Err("插件状态组件不可用".into());}
    crate::plugin_canvas::open(app,id)
}
#[allow(dead_code)]
fn open_legacy(app:&tauri::AppHandle,id:&str)->Result<(),String> {
    if !available(app,id){return Err("插件状态组件不可用，请重新加载插件".into());}
    let state=app.state::<State>();let mut prefs=state.prefs(id);prefs.desktop=true;state.save(id,prefs.clone())?;
    let name=label(id);
    if let Some(window)=app.get_webview_window(&name) {window.show().map_err(|e|e.to_string())?;return window.set_focus().map_err(|e|e.to_string());}
    let mut builder=WebviewWindowBuilder::new(app,&name,WebviewUrl::App(format!("plugin-status.html?id={id}").into()))
        .title("FlowHub · 插件状态").inner_size(360.,480.).min_inner_size(300.,260.)
        .always_on_top(prefs.pinned).skip_taskbar(true);
    if let Some((x,y))=prefs.position.filter(|(x,y)|x.is_finite()&&y.is_finite()) {
        // Ignore positions from disconnected monitors.
        let visible=app.available_monitors().unwrap_or_default().iter().any(|m| {
            let p=m.position().to_logical::<f64>(m.scale_factor());let s=m.size().to_logical::<f64>(m.scale_factor());
            x>=p.x && y>=p.y && x<p.x+s.width-80. && y<p.y+s.height-80.
        });
        builder=if visible {builder.position(x,y)} else {builder.center()};
    } else {builder=builder.center();}
    let window=builder.build().map_err(|e|e.to_string())?;
    let handle=app.clone();let plugin=id.to_string();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested{api,..}=event {
            api.prevent_close();
            if let Some(w)=handle.get_webview_window(&label(&plugin)) {
                let state=handle.state::<State>();let mut prefs=state.prefs(&plugin);prefs.desktop=false;
                if let (Ok(p),Ok(scale))=(w.outer_position(),w.scale_factor()) {let p=p.to_logical::<f64>(scale);prefs.position=Some((p.x,p.y));}
                let _=state.save(&plugin,prefs);let _=w.hide();
            }
        }
    });
    Ok(())
}
pub(crate) fn open_plugin(app:&tauri::AppHandle,id:&str) {
    if crate::open_settings_window(app.clone(),None,false).is_ok() {
        if let Some(w)=app.get_webview_window("settings") {
            let module=json!(format!("plugin:{id}"));
            let _=w.eval(&format!("(()=>{{let n=0;const go=async()=>{{if(window.FlowHubPluginIntegration){{await window.FlowHubPluginIntegration.refresh();switchModule({module});}}else if(++n<50)setTimeout(go,100);}};go();}})()"));
        }
    }
}
#[tauri::command]
pub(crate) fn plugin_status_api(window:tauri::WebviewWindow,app:tauri::AppHandle,id:String,action:String,payload:Value)->Result<Value,String> {
    if window.label()!="settings" && window.label()!="plugin-canvas" && window.label()!=label(&id) {return Err("状态组件来源无效".into());}
    if !available(&app,&id){return Err("插件状态组件不可用，请在市场重新加载插件".into());}
    let state=app.state::<State>();
    match action.as_str() {
        "open"=>{open(&app,&id)?;},
        "plugin"=>{open_plugin(&app,&id);},
        "menu"=>{
            if !state.prefs(&id).tray {return Err("请先开启并保存菜单栏状态".into());}
            let tray=app.tray_by_id(label(&id).as_str()).ok_or("菜单栏正在初始化，请稍后重试")?;
            #[cfg(target_os="macos")]
            tray.with_inner_tray_icon(|tray| {
                if let Some(mtm)=objc2::MainThreadMarker::new() {
                    if let Some(button)=tray.ns_status_item().and_then(|status|status.button(mtm)) {
                        unsafe {button.performClick(None);}
                    }
                }
            }).map_err(|e|e.to_string())?;
        },
        "save"=>{
            let mut prefs=state.prefs(&id);
            if let Some(v)=payload["tray"].as_bool(){prefs.tray=v;}
            if let Some(v)=payload["pinned"].as_bool(){prefs.pinned=v;}
            if let Some(v)=payload["favorites"].as_array(){
                if v.len()>200 || v.iter().any(|v|v.as_str().is_none_or(|s|s.len()>128)){return Err("关注列表无效".into());}
                prefs.favorites=v.iter().filter_map(|v|v.as_str().map(str::to_string)).collect();
            }
            state.save(&id,prefs.clone())?;
            if let Some(w)=app.get_webview_window(&label(&id)){w.set_always_on_top(prefs.pinned).map_err(|e|e.to_string())?;}
            if !prefs.tray {app.remove_tray_by_id(label(&id).as_str());state.menus.lock().unwrap().remove(&id);}
        },
        "get"=>{},_=>return Err("未知状态组件操作".into()),
    }
    Ok(json!({"preferences":state.prefs(&id),"snapshot":state.cache.lock().unwrap().get(&id).cloned()}))
}
fn rows(snapshot:&Value,prefs:&Preferences)->Vec<Value> {
    snapshot["rows"].as_array().into_iter().flatten().filter(|r|prefs.favorites.is_empty() || prefs.favorites.iter().any(|id|r["id"]==*id)).take(200).cloned().collect()
}
fn status_label(status:&str)->&str {match status {"healthy"=>"正常","error"=>"异常","stale"=>"已过期",_=>"未采集"}}
fn update_tray(app:&tauri::AppHandle,id:&str,title:&str,snapshot:&Value)->Result<(),String> {
    use tauri::{menu::MenuBuilder,tray::TrayIconBuilder};
    let state=app.state::<State>();let prefs=state.prefs(id);if !prefs.tray{return Ok(());}
    let rows=rows(snapshot,&prefs);
    let healthy=rows.iter().filter(|r|r["status"]=="healthy").count();
    let prefix=format!("status:{id}:");
    let mut menu=MenuBuilder::new(app).text(format!("{prefix}summary"),format!("{title} · {healthy}/{} 正常",rows.len())).separator();
    if let Some(error)=snapshot["error"].as_str(){menu=menu.text(format!("{prefix}error"),error.chars().take(100).collect::<String>());}
    for (i,row) in rows.iter().take(12).enumerate() {
        let name:String=row["name"].as_str().unwrap_or("未命名").chars().take(35).collect();
        let summary:String=row["summary"].as_str().unwrap_or_else(||status_label(row["status"].as_str().unwrap_or("unknown"))).chars().take(160).collect();
        let text=format!("{name} · {summary}");
        menu=menu.text(format!("{prefix}row-{i}"),text);
    }
    menu=menu.separator().text(format!("{prefix}desktop"),"打开桌面监控 / 配置").text(format!("{prefix}plugin"),"打开插件");
    let signature=json!([rows,snapshot["error"]]).to_string();
    if state.menus.lock().unwrap().get(id)==Some(&signature){return Ok(());}
    let menu=menu.build().map_err(|e|e.to_string())?;let tray_id=label(id);
    if let Some(tray)=app.tray_by_id(&tray_id){tray.set_menu(Some(menu)).map_err(|e|e.to_string())?;}
    else {
        let plugin=id.to_string();
        let mut builder=TrayIconBuilder::with_id(&tray_id).title(title).tooltip(format!("{title} · 缓存状态")).menu(&menu).show_menu_on_left_click(true)
            .on_menu_event(move |app,event| {if let Some(action)=event.id().0.strip_prefix(&prefix){if action=="desktop" {let _=open(app,&plugin);}else{open_plugin(app,&plugin);}}});
        if let Some(icon)=app.default_window_icon(){builder=builder.icon(icon.clone());}
        builder.build(app).map_err(|e|e.to_string())?;
    }
    state.menus.lock().unwrap().insert(id.into(),signature);Ok(())
}
pub(crate) fn start(app:tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut initialized=std::collections::HashSet::new();
        let mut menu_plugins=app.state::<crate::plugin_runtime::Runtime>().status_plugins();
        loop {
            let plugins=app.state::<crate::plugin_runtime::Runtime>().status_plugins();
            if plugins!=menu_plugins {
                menu_plugins=plugins.clone();
                #[cfg(target_os="macos")]
                crate::menu_bar::schedule_flowhub_menu_refresh(&app);
            }
            for (id,title) in &plugins {
                let prefs=app.state::<State>().prefs(id);
                let result=app.state::<crate::plugin_runtime::Runtime>().status_snapshot(id).await;
                let snapshot=result.unwrap_or_else(|e|json!({"rows":[],"error":e}));
                app.state::<State>().cache.lock().unwrap().insert(id.clone(),snapshot.clone());
                let handle=app.clone();let id=id.clone();let title=title.clone();
                let restore=initialized.insert(id.clone()) && prefs.desktop;
                let _=app.run_on_main_thread(move || {let _=update_tray(&handle,&id,&title,&snapshot);if restore {let _=open(&handle,&id);}});
            }
            let obsolete:Vec<String>=initialized.iter().filter(|id|!plugins.iter().any(|(key,_)|key==*id)).cloned().collect();
            for id in obsolete {
                initialized.remove(&id);app.remove_tray_by_id(label(&id).as_str());
                app.state::<State>().menus.lock().unwrap().remove(&id);
                app.state::<State>().cache.lock().unwrap().remove(&id);
                if let Some(w)=app.get_webview_window(&label(&id)){let _=w.destroy();}
            }
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn favorites_filter_by_id_and_empty_means_all() {
        let snapshot=json!({"rows":[{"id":"a","name":"same"},{"id":"b","name":"same"}]});
        let mut prefs=Preferences::default();assert_eq!(rows(&snapshot,&prefs).len(),2);
        prefs.favorites=vec!["b".into()];assert_eq!(rows(&snapshot,&prefs)[0]["id"],"b");
        prefs.favorites=vec!["removed".into()];assert!(rows(&snapshot,&prefs).is_empty());
    }
    #[test]
    fn preferences_survive_restart() {
        let root=std::env::temp_dir().join(format!("status-prefs-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();let state=State::new(&root).unwrap();
        let mut prefs=Preferences::default();prefs.pinned=true;prefs.tray=false;prefs.position=Some((20.,30.));
        state.save("example",prefs).unwrap();let next=State::new(&root).unwrap().prefs("example");
        assert!(next.pinned);assert!(!next.tray);assert_eq!(next.position,Some((20.,30.)));
        std::fs::remove_dir_all(root).unwrap();
    }
}
