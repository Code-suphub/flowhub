//! Independent host windows. The dock has a tight hit area; its panel is a
//! separate window above it, never a transparent extension of Settings.
use serde::Serialize;
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const DOCK: &str = "plugin-dock";
const PANEL: &str = "plugin-panel";
#[derive(Clone, Default, Serialize)]
pub(crate) struct Snapshot { module: String, open: bool, revision: u64 }
#[derive(Default)]
pub(crate) struct Workspace(Mutex<Snapshot>, AtomicBool);

fn allowed(label: &str) -> bool { matches!(label, "settings" | DOCK | PANEL) }
fn valid_module(module: &str) -> bool {
    matches!(module, "extensions" | "overflow") || module.strip_prefix("plugin:").is_some_and(|id|
        !id.is_empty() && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
}
fn snapshot(app: &tauri::AppHandle) -> Snapshot { app.state::<Workspace>().0.lock().unwrap().clone() }
fn publish(app: &tauri::AppHandle) {
    let value = serde_json::to_string(&snapshot(app)).unwrap();
    for label in [DOCK, PANEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('flowhub-workspace', {{detail:{value}}}));"));
        }
    }
}
fn builder<'a>(app: &'a tauri::AppHandle, label: &'a str, mode: &str) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("plugin-workspace.html?view={mode}").into()))
        .title(if label == DOCK { "FlowHub 插件栏" } else { "FlowHub 插件面板" })
        .decorations(false).transparent(true).background_color(tauri::window::Color(0,0,0,0))
        .resizable(false).always_on_top(true).skip_taskbar(true).accept_first_mouse(true).visible(false)
}

// Geometry is in physical pixels, including negative monitor origins.
type Rect = (i32,i32,u32,u32);
fn settings_pair(area: Rect, settings: Rect, dock_width: u32, scale: f64) -> (Rect, Rect) {
    let (ax,ay,aw,ah)=area;
    let margin=(12.0*scale).round() as u32;
    let gap=(12.0*scale).round() as u32;
    let dock_height=(60.0*scale).round() as u32;
    let width=settings.2.min(aw.saturating_sub(2*margin)).max(1);
    let height=settings.3.min(ah.saturating_sub(2*margin+gap+dock_height)).max(1);
    let dock_width=dock_width.min(aw.saturating_sub(2*margin)).max(1);
    let x=settings.0.clamp(ax+margin as i32,(ax+aw as i32-width as i32-margin as i32).max(ax+margin as i32));
    let y=settings.1.clamp(ay+margin as i32,(ay+ah as i32-height as i32-dock_height as i32-gap as i32-margin as i32).max(ay+margin as i32));
    let dx=(x+(width as i32-dock_width as i32)/2).clamp(ax+margin as i32,(ax+aw as i32-dock_width as i32-margin as i32).max(ax+margin as i32));
    ((x,y,width,height),(dx,y+height as i32+gap as i32,dock_width,dock_height))
}

/// Resolve the monitor from Settings, never from the dock's previous screen.
/// Keep the two native windows together, leaving room for the entire capsule.
pub(crate) fn follow_settings(app: &tauri::AppHandle) -> Result<(),String> {
    let Some(settings)=app.get_webview_window("settings") else {return Ok(())};
    let Some(dock)=app.get_webview_window(DOCK) else {return Ok(())};
    if !settings.is_visible().map_err(|e|e.to_string())? || settings.is_minimized().map_err(|e|e.to_string())? || !dock.is_visible().map_err(|e|e.to_string())? {return Ok(())}
    let monitor=settings.current_monitor().map_err(|e|e.to_string())?.ok_or("无法读取设置所在显示器")?;
    let area=monitor.work_area();let scale=monitor.scale_factor();
    let pos=settings.outer_position().map_err(|e|e.to_string())?;
    let size=settings.outer_size().map_err(|e|e.to_string())?;
    let dock_size=dock.outer_size().map_err(|e|e.to_string())?;
    let dock_scale=dock.scale_factor().map_err(|e|e.to_string())?;
    let (s,d)=settings_pair((area.position.x,area.position.y,area.size.width,area.size.height),(pos.x,pos.y,size.width,size.height),(dock_size.width as f64/dock_scale*scale).round() as u32,scale);
    if (size.width,size.height)!=(s.2,s.3) {
        let inner=settings.inner_size().map_err(|e|e.to_string())?;
        settings.set_size(PhysicalSize::new(s.2.saturating_sub(size.width.saturating_sub(inner.width)).max(1),s.3.saturating_sub(size.height.saturating_sub(inner.height)).max(1))).map_err(|e|e.to_string())?;
    }
    if (pos.x,pos.y)!=(s.0,s.1) {settings.set_position(PhysicalPosition::new(s.0,s.1)).map_err(|e|e.to_string())?;}
    let dock_pos=dock.outer_position().map_err(|e|e.to_string())?;
    if (dock_pos.x,dock_pos.y)!=(d.0,d.1) {dock.set_position(PhysicalPosition::new(d.0,d.1)).map_err(|e|e.to_string())?;}
    if (dock_size.width,dock_size.height)!=(d.2,d.3) {dock.set_size(PhysicalSize::new(d.2,d.3)).map_err(|e|e.to_string())?;}
    if snapshot(app).open {anchor(app)?;}
    Ok(())
}
pub(crate) fn schedule_follow(app: &tauri::AppHandle) {
    // Coalesce resize/move bursts and sample the latest geometry on AppKit's
    // thread. Do not queue one blocking worker for every pixel of a drag.
    if app.state::<Workspace>().1.swap(true,Ordering::AcqRel) {return}
    let handle=app.clone();
    if app.run_on_main_thread(move || {
        let result=follow_settings(&handle);
        handle.state::<Workspace>().1.store(false,Ordering::Release);
        if let Err(error)=result {eprintln!("[flowhub-tauri] 插件栏跟随：{error}");}
    }).is_err() {app.state::<Workspace>().1.store(false,Ordering::Release);}
}
fn panel_rect(area: (i32,i32,u32,u32), dock: (i32,i32,u32,u32), scale: f64) -> (i32,i32,u32,u32) {
    let (ax,ay,aw,ah) = area;
    let margin = (12.0 * scale) as i32;
    let gap = (12.0 * scale) as i32;
    let width = ((800.0 * scale) as u32).min(aw.saturating_sub(2 * margin as u32)).max(1);
    let available_above=(dock.1-ay-margin-gap).max(1) as u32;
    let height = ((560.0 * scale) as u32).min(available_above).min(ah.saturating_sub(dock.3 + (gap + 2 * margin) as u32)).max(1);
    let x = (dock.0 + (dock.2 as i32 - width as i32)/2).clamp(ax + margin, (ax + aw as i32 - width as i32 - margin).max(ax + margin));
    let y = (dock.1 - height as i32 - gap).max(ay + margin);
    (x,y,width,height)
}
fn anchor(app: &tauri::AppHandle) -> Result<(),String> {
    let Some(dock) = app.get_webview_window(DOCK) else { return Ok(()) };
    let Some(panel) = app.get_webview_window(PANEL) else { return Ok(()) };
    let monitor = dock.current_monitor().map_err(|e|e.to_string())?.ok_or("无法读取显示器")?;
    let area = monitor.work_area();
    let pos = dock.outer_position().map_err(|e|e.to_string())?;
    let size = dock.outer_size().map_err(|e|e.to_string())?;
    let (x,y,w,h) = panel_rect((area.position.x,area.position.y,area.size.width,area.size.height),(pos.x,pos.y,size.width,size.height),monitor.scale_factor());
    panel.set_size(PhysicalSize::new(w,h)).map_err(|e|e.to_string())?;
    panel.set_position(PhysicalPosition::new(x,y)).map_err(|e|e.to_string())?;
    Ok(())
}
pub(crate) fn show_dock(app: &tauri::AppHandle) -> Result<(),String> {
    if let Some(dock) = app.get_webview_window(DOCK) { dock.show().map_err(|e|e.to_string())?;return follow_settings(app); }
    let dock = builder(app, DOCK, "dock").inner_size(600.0,60.0).build().map_err(|e|e.to_string())?;
    if let Some(monitor) = dock.current_monitor().map_err(|e|e.to_string())? {
        let area = monitor.work_area(); let size = dock.outer_size().map_err(|e|e.to_string())?;
        dock.set_position(PhysicalPosition::new(area.position.x + (area.size.width as i32-size.width as i32)/2,area.position.y+area.size.height as i32-size.height as i32-(24.0*monitor.scale_factor()) as i32)).map_err(|e|e.to_string())?;
    }
    let app_events = app.clone();
    dock.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged {..} => {
            if snapshot(&app_events).open { let app=app_events.clone(); tauri::async_runtime::spawn_blocking(move || {let _=anchor(&app);}); }
        }
        WindowEvent::CloseRequested {api,..} => { api.prevent_close(); let _=hide(&app_events); }
        _=>{}
    });
    dock.show().map_err(|e|e.to_string())?;
    follow_settings(app)
}
fn collapse(app: &tauri::AppHandle) -> Result<(),String> {
    { let state=app.state::<Workspace>(); let mut s=state.0.lock().unwrap(); s.open=false; s.revision+=1; }
    publish(app);
    if let Some(panel)=app.get_webview_window(PANEL) { panel.hide().map_err(|e|e.to_string())?; }
    Ok(())
}
fn hide(app: &tauri::AppHandle) -> Result<(),String> {
    collapse(app)?;
    if let Some(dock)=app.get_webview_window(DOCK) { dock.hide().map_err(|e|e.to_string())?; }
    Ok(())
}
pub(crate) fn select(app: &tauri::AppHandle, module: &str, toggle: bool) -> Result<(),String> {
    if !valid_module(module) { return Err("未知插件入口".into()); }
    show_dock(app)?;
    let current=snapshot(app);
    if toggle && current.open && current.module==module { return collapse(app); }
    if app.get_webview_window(PANEL).is_none() {
        let panel=builder(app,PANEL,"panel").inner_size(800.0,560.0).build().map_err(|e|e.to_string())?;
        let handle=app.clone();
        panel.on_window_event(move |event| { if let WindowEvent::CloseRequested {api,..}=event {api.prevent_close();let _=collapse(&handle);} });
    }
    { let state=app.state::<Workspace>();let mut s=state.0.lock().unwrap(); s.module=module.into();s.open=true;s.revision+=1; }
    anchor(app)?;
    publish(app);
    if let Some(panel)=app.get_webview_window(PANEL) {panel.show().map_err(|e|e.to_string())?;panel.set_focus().map_err(|e|e.to_string())?;}
    Ok(())
}
#[tauri::command]
pub(crate) async fn plugin_workspace(window: WebviewWindow, app: tauri::AppHandle, action: String, module: Option<String>, width: Option<f64>) -> Result<Snapshot,String> {
    if !allowed(window.label()) { return Err("插件工作区来源无效".into()); }
    match action.as_str() {
        "show"=>show_dock(&app)?,
        "select"=>select(&app,module.as_deref().unwrap_or("extensions"),window.label()==DOCK)?,
        "close"=>{collapse(&app)?;if let Some(dock)=app.get_webview_window(DOCK){let _=dock.set_focus();}},
        "hide"=>hide(&app)?,
        "ready"=>{},
        "resize" if window.label()==DOCK => {
            let width=width.filter(|w|w.is_finite()).ok_or("无效尺寸")?.clamp(180.0,640.0);
            let old=window.outer_size().map_err(|e|e.to_string())?;
            let pos=window.outer_position().map_err(|e|e.to_string())?;
            let scale=window.scale_factor().map_err(|e|e.to_string())?;
            let next=(width*scale).round() as u32;
            if old.width!=next {window.set_size(tauri::LogicalSize::new(width,60.0)).map_err(|e|e.to_string())?;window.set_position(PhysicalPosition::new(pos.x+(old.width as i32-next as i32)/2,pos.y)).map_err(|e|e.to_string())?;}
            follow_settings(&app)?;
            if snapshot(&app).open {anchor(&app)?;}
        }
        "refresh" if window.label()==PANEL => {
            if let Some(dock)=app.get_webview_window(DOCK) {let _=dock.eval("window.FlowHubPluginIntegration?.refresh();");}
        }
        _=>return Err("未知插件工作区操作".into())
    }
    Ok(snapshot(&app))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn settings_and_capsule_share_screen_center_and_twelve_point_gap() {
        for (area,settings,scale) in [((0,0,1920,1080),(300,100,980,720),1.0),((-3840,-200,3840,2160),(-3000,400,1960,1440),2.0),((1920,0,1440,900),(2600,600,1100,800),1.0)] {
            let (s,d)=settings_pair(area,settings,(500.0*scale) as u32,scale);
            assert_eq!(d.1-s.1-s.3 as i32,(12.0*scale) as i32);
            assert_eq!(d.0+d.2 as i32/2,s.0+s.2 as i32/2);
            assert!(s.0>=area.0 && d.0>=area.0);
            assert!(d.1+d.3 as i32<=area.1+area.3 as i32);
            assert!(s.0+s.2 as i32<=area.0+area.2 as i32);
        }
    }
    #[test] fn panel_stays_above_dock_and_inside_scaled_negative_monitor() {
        let (x,y,w,h)=panel_rect((-2560,0,2560,1440),(-2000,1250,1200,120),2.0);
        assert!(x>=-2536 && x+w as i32<=-24); assert_eq!(y+h as i32+24,1250);
        let (_,y,_,h)=panel_rect((0,0,800,600),(100,50,500,60),1.0);
        assert_eq!(y,12);assert!(y+h as i32+12+60<=588);
    }
    #[test] fn workspace_accepts_only_host_windows_and_bounded_plugin_ids() {
        for label in ["main","plugin-status-test","plugin-canvas","plugin-panel-evil"] {assert!(!allowed(label));}
        for label in ["settings",DOCK,PANEL] {assert!(allowed(label));}
        for id in ["plugin:","plugin:../settings","plugin:x';alert(1)","canvas"] {assert!(!valid_module(id));}
        assert!(valid_module("plugin:two-factor"));
    }
}
