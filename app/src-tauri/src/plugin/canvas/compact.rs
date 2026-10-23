use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(super) struct Favorite { pub board_id:String, pub card_id:String }
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub(super) struct Presentation { pub enabled:bool, pub collapsed:bool, pub favorites:Vec<Favorite>, pub revision:u64 }
impl Presentation { fn compact(&self)->bool {self.enabled && self.collapsed} }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all="lowercase")]
pub(super) enum Edge { Left, Right, Top, Bottom }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Geometry { x:i32, y:i32, width:u32, height:u32, scale:f64, nx:f64, ny:f64, edge:Option<Edge> }
#[derive(Clone, Debug)]
struct Display { key:String, x:i32, y:i32, width:u32, height:u32, scale:f64 }
#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
struct Saved { #[serde(flatten)] presentation:Presentation, geometries:HashMap<String,Geometry>, displays:HashMap<String,String> }
struct Inner { saved:Saved, generation:u64, transitioning:bool, window_geometry_restored:bool, window_session_started:bool, topology_token:Option<usize> }
pub(super) struct Store { path:PathBuf, inner:Mutex<Inner> }
fn mode(compact:bool)->&'static str {if compact {"compact"} else {"full"}}
fn slot(display:&str,compact:bool)->String {format!("{}:{display}",mode(compact))}
fn bounds(compact:bool)->(f64,f64,f64,f64) {if compact {(520.,64.,320.,64.)}else{(1040.,720.,360.,200.)}}

impl Store {
    pub fn new(root:&Path)->Result<Self,String> {
        let path=root.join("canvas-presentation.json");
        let saved:Saved=match std::fs::read(&path) {
            Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|e|e.to_string())?,
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Saved::default(),Err(e)=>return Err(e.to_string())
        };
        if saved.presentation.favorites.len()>384 || saved.geometries.len()>128 || saved.geometries.values().any(|g| !g.scale.is_finite() || g.scale<=0. || !g.nx.is_finite() || !g.ny.is_finite() || g.width==0 || g.height==0) {return Err("紧凑入口配置无效".into());}
        let mut saved=saved;if !saved.presentation.enabled {saved.presentation.collapsed=false;}
        Ok(Self{path,inner:Mutex::new(Inner{saved,generation:0,transitioning:false,window_geometry_restored:false,window_session_started:false,topology_token:None})})
    }
    pub fn presentation(&self,layout:&super::Layout)->Presentation {
        let mut p=self.inner.lock().unwrap().saved.presentation.clone();
        p.favorites.retain(|f|valid_favorite(f,layout));p
    }
    pub fn busy_or_compact(&self)->bool {let inner=self.inner.lock().unwrap();inner.transitioning || inner.saved.presentation.compact()}
    pub fn window_geometry_restored(&self)->bool {self.inner.lock().unwrap().window_geometry_restored}
    fn start_window_session(&self) {
        let mut inner=self.inner.lock().unwrap();
        if !inner.window_session_started {
            inner.window_geometry_restored=!inner.saved.presentation.compact() && inner.saved.geometries.keys().any(|key|key.starts_with("full:"));
            inner.window_session_started=true;
        }
    }
    fn end_window_session(&self) {let mut inner=self.inner.lock().unwrap();inner.window_session_started=false;inner.window_geometry_restored=false;}
    fn begin(&self)->Result<(Saved,u64),String> {
        let mut inner=self.inner.lock().unwrap();
        if inner.transitioning {return Err("窗口模式正在切换，请稍后重试".into());}
        inner.transitioning=true;inner.generation+=1;Ok((inner.saved.clone(),inner.generation))
    }
    fn finish(&self,generation:u64,next:Option<Saved>)->Result<(),String> {
        let mut inner=self.inner.lock().unwrap();
        if generation!=inner.generation {return Err("窗口模式已变化".into());}
        let result=if let Some(next)=next {
            crate::storage::write_json_atomic(&self.path,&json!(next)).map(|_|inner.saved=next)
        } else {Ok(())};
        if result.is_ok(){inner.transitioning=false;}result
    }
    fn record(&self,generation:u64,display:&Display,geometry:Geometry)->Result<(),String> {
        let mut inner=self.inner.lock().unwrap();
        if inner.transitioning || generation!=inner.generation {return Ok(());}
        let compact=inner.saved.presentation.compact();let mut next=inner.saved.clone();
        next.geometries.insert(slot(&display.key,compact),geometry);next.displays.insert(mode(compact).into(),display.key.clone());
        if next==inner.saved {return Ok(());}
        crate::storage::write_json_atomic(&self.path,&json!(next))?;inner.saved=next;Ok(())
    }
}
fn valid_favorite(f:&Favorite,layout:&super::Layout)->bool {layout.boards.iter().find(|b|b.id==f.board_id).is_some_and(|b|b.cards.iter().any(|c|c.id==f.card_id))}

// All native presentation operations, including creation and event sampling, run
// on the UI thread. No store mutex is held while invoking a window operation.
pub(super) fn on_main<T:Send+'static>(app:&tauri::AppHandle,work:impl FnOnce(&tauri::AppHandle)->Result<T,String>+Send+'static)->Result<T,String> {
    let (tx,rx)=std::sync::mpsc::sync_channel(1);let handle=app.clone();
    app.run_on_main_thread(move||{let _=tx.send(work(&handle));}).map_err(|e|e.to_string())?;
    rx.recv().map_err(|_|"窗口操作中断".to_string())?
}

#[cfg(target_os="macos")]
fn display_uuid(m:&tauri::Monitor)->Option<String> {
    use core_foundation::{base::TCFType,string::CFString,uuid::{CFUUID,CFUUIDCreateString,CFUUIDRef}};
    extern "C" {fn CGDisplayCreateUUIDFromDisplayID(display:u32)->CFUUIDRef;}
    // Tao exposes CG bounds scaled by the monitor's own scale. Match these
    // current coordinates only to identify the UUID; coordinates never enter key.
    let scale=m.scale_factor();
    let matches:Vec<_>=core_graphics::display::CGDisplay::active_displays().ok()?.into_iter().filter(|id|{
        let b=core_graphics::display::CGDisplay::new(*id).bounds();
        (b.origin.x*scale-m.position().x as f64).abs()<2. && (b.origin.y*scale-m.position().y as f64).abs()<2.
    }).collect();
    if matches.len()!=1 {return None;}
    unsafe {
        let uuid=CGDisplayCreateUUIDFromDisplayID(matches[0]);if uuid.is_null(){return None;}
        let uuid=CFUUID::wrap_under_create_rule(uuid);
        let text=CFUUIDCreateString(std::ptr::null(),uuid.as_concrete_TypeRef());if text.is_null(){return None;}
        Some(format!("cg:{}",CFString::wrap_under_create_rule(text)))
    }
}
fn displays(app:&tauri::AppHandle)->Result<Vec<Display>,String> {
    let monitors=app.available_monitors().map_err(|e|e.to_string())?;let mut names:HashMap<String,usize>=HashMap::new();
    let mut output=vec![];
    for m in monitors {
        let name=m.name().cloned().unwrap_or_else(||"unnamed".into());let ordinal=names.entry(name.clone()).or_default();
        // Fallback on platforms without stable IDs: same-name enumeration ordinal.
        // Identical displays can exchange that ordinal after reconnection.
        let fallback=format!("monitor:{name}:{}",*ordinal);*ordinal+=1;
        #[cfg(target_os="macos")]
        let key=display_uuid(&m).unwrap_or(fallback);
        #[cfg(not(target_os="macos"))]
        let key=fallback;
        let area=m.work_area();let scale=m.scale_factor();
        if area.size.width>0 && area.size.height>0 && scale.is_finite() && scale>0. {
            output.push(Display{key,x:area.position.x,y:area.position.y,width:area.size.width,height:area.size.height,scale});
        }
    }
    if output.is_empty(){return Err("当前没有可用显示器".into());}Ok(output)
}
fn sampled(window:&tauri::WebviewWindow,displays:&[Display])->Result<(Display,Geometry),String> {
    let p=window.outer_position().map_err(|e|e.to_string())?;let s=window.inner_size().map_err(|e|e.to_string())?;
    let scale=window.scale_factor().map_err(|e|e.to_string())?;
    let display=displays.iter().filter(|d|(d.scale-scale).abs()<0.01).min_by_key(|d|{
        let dx=(p.x as i64-d.x as i64).abs();let dy=(p.y as i64-d.y as i64).abs();
        if p.x>=d.x && p.y>=d.y && (p.x as i64)<d.x as i64+d.width as i64 && (p.y as i64)<d.y as i64+d.height as i64 {0}else{dx+dy+1}
    }).or_else(||displays.first()).ok_or("当前没有可用显示器")?.clone();
    let mut actual=geometry(&display,p.x,p.y,s.width,s.height,None);actual.scale=scale;
    Ok((display,actual))
}
fn geometry(display:&Display,x:i32,y:i32,width:u32,height:u32,edge:Option<Edge>)->Geometry {
    Geometry{x,y,width,height,scale:display.scale,nx:((x as f64-display.x as f64)/(display.width.saturating_sub(width).max(1) as f64)).clamp(0.,1.),ny:((y as f64-display.y as f64)/(display.height.saturating_sub(height).max(1) as f64)).clamp(0.,1.),edge}
}
fn restore(saved:Option<&Geometry>,display:&Display,compact:bool)->Geometry {
    let (w,h,minw,minh)=bounds(compact);let scale=display.scale;
    let width=((saved.map(|g|g.width as f64/g.scale).unwrap_or(w)).max(minw)*scale).round().clamp(1.,display.width as f64) as u32;
    let height=((saved.map(|g|g.height as f64/g.scale).unwrap_or(h)).max(minh)*scale).round().clamp(1.,display.height as f64) as u32;
    let edge=saved.and_then(|g|g.edge);
    let nx=if edge==Some(Edge::Left){0.}else if edge==Some(Edge::Right){1.}else{saved.map(|g|g.nx).unwrap_or(0.5)};
    let ny=if edge==Some(Edge::Top){0.}else if edge==Some(Edge::Bottom){1.}else{saved.map(|g|g.ny).unwrap_or(0.5)};
    geometry(display,(display.x as f64+nx*(display.width-width) as f64).round() as i32,(display.y as f64+ny*(display.height-height) as f64).round() as i32,width,height,edge)
}
fn apply(window:&tauri::WebviewWindow,g:&Geometry,d:&Display,compact:bool)->Result<(),String> {
    let (_,_,minw,minh)=bounds(compact);
    #[cfg(target_os="macos")]
    {
        // Tao's macOS position/size setters enqueue GCD work even on the UI
        // thread. Apply a complete frame synchronously before sampling/commit.
        let (tx,rx)=std::sync::mpsc::sync_channel(1);let g=g.clone();let d=d.clone();
        window.with_webview(move|webview|{
            let result=if objc2::MainThreadMarker::new().is_none(){Err("窗口几何只能在主线程修改".into())}else{
                unsafe {
                    let native=&*webview.ns_window().cast::<objc2_app_kit::NSWindow>();
                    native.setContentMinSize(objc2_foundation::NSSize::new(minw.min(d.width as f64/d.scale),minh.min(d.height as f64/d.scale)));
                    // Match Tao's outer_position inverse exactly. On macOS
                    // CGDisplayPixelsHigh uses the display coordinate height.
                    let (x,y,w,h)=appkit_rect(&g,core_graphics::display::CGDisplay::main().pixels_high() as f64);
                    // The canvas is undecorated: its content and frame extents
                    // coincide. setFrame is synchronous and does not animate.
                    native.setFrame_display(objc2_foundation::NSRect::new(objc2_foundation::NSPoint::new(x,y),objc2_foundation::NSSize::new(w,h)),true);
                }
                Ok(())
            };
            let _=tx.send(result);
        }).map_err(|e|e.to_string())?;
        return rx.recv().map_err(|_|"窗口几何更新中断".to_string())?;
    }
    #[cfg(not(target_os="macos"))]
    {
    // Clear the previous mode's minimum before shrinking. Work areas smaller
    // than the preferred minimum still win, keeping every edge reachable.
    window.set_min_size(Some(tauri::LogicalSize::new(minw.min(d.width as f64/d.scale),minh.min(d.height as f64/d.scale)))).map_err(|e|e.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(g.x,g.y)).map_err(|e|e.to_string())?;
    window.set_size(tauri::LogicalSize::new(g.width as f64/d.scale,g.height as f64/d.scale)).map_err(|e|e.to_string())?;
    Ok(())
    }
}
#[cfg(any(target_os="macos",test))]
fn appkit_rect(g:&Geometry,primary_height:f64)->(f64,f64,f64,f64) {
    let (x,top,w,h)=(g.x as f64/g.scale,g.y as f64/g.scale,g.width as f64/g.scale,g.height as f64/g.scale);
    (x,primary_height-top-h,w,h)
}
fn ensure_applied(expected:&Geometry,actual:&Geometry)->Result<(),String> {
    if (expected.x as i64-actual.x as i64).abs()>2 || (expected.y as i64-actual.y as i64).abs()>2 || (expected.width as i64-actual.width as i64).abs()>2 || (expected.height as i64-actual.height as i64).abs()>2 || (expected.scale-actual.scale).abs()>0.01 {return Err("窗口几何尚未完成，请重试".into());}Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configure {enabled:bool,favorites:Vec<Favorite>}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Collapse {collapsed:bool}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snap {edge:Edge}
fn plan(old:&Presentation,layout:&super::Layout,action:&str,payload:Value)->Result<(Presentation,Option<Edge>),String> {
        let mut next=old.clone();
        let mut snap=None;
        match action {
            "configureCompact"=>{
                let request:Configure=serde_json::from_value(payload).map_err(|e|e.to_string())?;
                let unique:std::collections::HashSet<_>=request.favorites.iter().collect();
                if request.favorites.len()>384 || unique.len()!=request.favorites.len() || request.favorites.iter().any(|f|!valid_favorite(f,layout)){return Err("关注组件无效".into());}
                next.enabled=request.enabled;next.favorites=request.favorites;
                if !request.enabled {next.collapsed=false;}
            }
            "setCompact"=>{
                let request:Collapse=serde_json::from_value(payload).map_err(|e|e.to_string())?;
                if request.collapsed && !next.enabled {return Err("请先启用紧凑入口".into());}
                next.collapsed=request.collapsed;
            }
            "snapCompact"=>{
                if !next.compact(){return Err("仅可将紧凑入口贴边".into());}
                snap=Some(serde_json::from_value::<Snap>(payload).map_err(|e|e.to_string())?.edge);
            }
            _=>return Err("未知紧凑入口操作".into())
        }
        next.favorites.retain(|f|valid_favorite(f,layout));
        next.revision=next.revision.checked_add(1).ok_or("紧凑入口版本超出范围")?;
        Ok((next,snap))
}
fn allowed(origin:&str,action:&str)->bool {["settings","plugin-canvas"].contains(&origin) && (action=="configureCompact" || origin=="plugin-canvas")}
pub(super) fn action(app:&tauri::AppHandle,origin:&str,action:&str,payload:Value)->Result<Presentation,String> {
    if !allowed(origin,action) {return Err("紧凑入口来源无效".into());}
    let state=app.state::<super::State>();let store=&state.compact;
    let (old,generation)=store.begin()?;let mut next=old.clone();let mut rollback=old.clone();let mut changed=false;
    let result=(||->Result<(),String>{
        let layout=state.layout.lock().unwrap().clone();
        let (presentation,snap)=plan(&old.presentation,&layout,action,payload)?;next.presentation=presentation;
        if let Some(window)=app.get_webview_window("plugin-canvas") {
            let available=displays(app)?;let (display,mut actual)=sampled(&window,&available)?;let was=old.presentation.compact();
            actual.edge=old.geometries.get(&slot(&display.key,was)).and_then(|g|g.edge);
            rollback.geometries.insert(slot(&display.key,was),actual);rollback.displays.insert(mode(was).into(),display.key);
            changed=was!=next.presentation.compact() || snap.is_some();
            transition(&window,app,&old,&mut next,snap)?;
        }
        store.finish(generation,Some(next.clone()))
    })();
    if let Err(error)=result {
        // The old saved state remains authoritative on any failed native or
        // persistence operation. Restore actual geometry before releasing mode.
        let rollback_error=if changed {app.get_webview_window("plugin-canvas").and_then(|window|restore_saved(&window,app,&rollback).err())} else {None};
        let _=store.finish(generation,None);return Err(if let Some(rollback)=rollback_error {format!("{error}；恢复窗口失败：{rollback}")}else{error});
    }
    publish(app,&next.presentation);
    Ok(next.presentation)
}
fn target_display<'a>(saved:&Saved,available:&'a [Display],compact:bool,current:&Display)->&'a Display {
    saved.displays.get(mode(compact)).and_then(|key|available.iter().find(|d|&d.key==key))
        .or_else(||available.iter().find(|d|d.key==current.key)).unwrap_or(&available[0])
}
fn transition(window:&tauri::WebviewWindow,app:&tauri::AppHandle,old:&Saved,next:&mut Saved,snap:Option<Edge>)->Result<(),String> {
    let available=displays(app)?;let (current,actual)=sampled(window,&available)?;let was=old.presentation.compact();let compact=next.presentation.compact();
    let oldedge=old.geometries.get(&slot(&current.key,was)).and_then(|g|g.edge);
    let actual=Geometry{edge:oldedge,..actual};
    next.geometries.insert(slot(&current.key,was),actual.clone());next.displays.insert(mode(was).into(),current.key.clone());
    if was==compact && snap.is_none(){return Ok(());}
    let target=if snap.is_some(){&current}else{target_display(next,&available,compact,&current)};
    let mut saved=next.geometries.get(&slot(&target.key,compact)).cloned();
    if let Some(edge)=snap {saved=Some(Geometry{edge:Some(edge),..actual});}
    let target_geometry=restore(saved.as_ref(),target,compact);
    apply(window,&target_geometry,target,compact)?;
    let (display,mut applied)=sampled(window,&available)?;applied.edge=target_geometry.edge;
    ensure_applied(&target_geometry,&applied)?;
    next.geometries.insert(slot(&display.key,compact),applied);next.displays.insert(mode(compact).into(),display.key);
    Ok(())
}
fn restore_saved(window:&tauri::WebviewWindow,app:&tauri::AppHandle,saved:&Saved)->Result<(),String> {
    let available=displays(app)?;let (current,_)=sampled(window,&available)?;let compact=saved.presentation.compact();
    let display=target_display(saved,&available,compact,&current);
    let geometry=restore(saved.geometries.get(&slot(&display.key,compact)),display,compact);
    apply(window,&geometry,display,compact)?;
    ensure_applied(&geometry,&sampled(window,&available)?.1)
}
pub(super) fn restore_window(app:&tauri::AppHandle,window:&tauri::WebviewWindow,legacy:Option<super::Layout>)->Result<(),String> {
    let state=app.state::<super::State>();let store=&state.compact;store.start_window_session();let (mut saved,generation)=store.begin()?;
    let result=(||->Result<(),String>{
        if !saved.presentation.compact() && saved.geometries.is_empty() {
            #[cfg(target_os="macos")]
            if let Some(layout)=legacy.filter(|layout|layout.window_position_appkit.is_some() || layout.window_position.is_some()) {
                // Migrate the legacy AppKit position in native points first.
                // Sampling then seeds the per-display full geometry without
                // guessing a physical origin on mixed-scale monitors.
                super::restore_canvas_position(window,layout)?;
                let available=displays(app)?;
                let (display,actual)=sampled(window,&available)?;
                saved.geometries.insert(slot(&display.key,false),actual);
                saved.displays.insert("full".into(),display.key);
            }
            #[cfg(not(target_os="macos"))]
            if let Some((x,y))=legacy.and_then(|layout|layout.window_position) {
                let available=displays(app)?;
                if let Some(display)=available.iter().find(|d|x>=d.x&&y>=d.y&&(x as i64)<d.x as i64+d.width as i64&&(y as i64)<d.y as i64+d.height as i64) {
                    saved.geometries.insert(slot(&display.key,false),geometry(display,x,y,(1040.*display.scale) as u32,(720.*display.scale) as u32,None));saved.displays.insert("full".into(),display.key.clone());
                }
            }
        }
        restore_saved(window,app,&saved)?;
        let available=displays(app)?;let (display,mut actual)=sampled(window,&available)?;let compact=saved.presentation.compact();
        actual.edge=saved.geometries.get(&slot(&display.key,compact)).and_then(|g|g.edge);
        saved.geometries.insert(slot(&display.key,compact),actual);saved.displays.insert(mode(compact).into(),display.key);
        store.finish(generation,Some(saved))
    })();
    if result.is_err(){let _=store.finish(generation,None);}result
}
pub(super) fn record_window(app:&tauri::AppHandle,window:&tauri::WebviewWindow) {
    let state=app.state::<super::State>();let store=&state.compact;
    let generation={let inner=store.inner.lock().unwrap();if inner.transitioning{return;}inner.generation};
    // Delayed Moved/Resized payloads are intentionally ignored: sample the
    // current native frame after any queued transition, then check generation.
    if let Ok(available)=displays(app) {if let Ok((display,mut actual))=sampled(window,&available) {
        if entirely_offscreen(&actual,&available){return;}
        let edge={let inner=store.inner.lock().unwrap();inner.saved.geometries.get(&slot(&display.key,inner.saved.presentation.compact())).and_then(|g|g.edge)};
        actual.edge=edge;let _=store.record(generation,&display,actual);
    }}
}
pub(super) fn prepare_drag(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<(),String> {
    let state=app.state::<super::State>();let store=&state.compact;
    let generation={let inner=store.inner.lock().unwrap();if inner.transitioning{return Err("窗口模式正在切换".into());}inner.generation};
    let available=displays(app)?;let (display,actual)=sampled(window,&available)?;
    // Starting a free drag explicitly releases a previous snap. Delayed native
    // events then sample the actual frame instead of reinstating the old edge.
    store.record(generation,&display,actual)
}
pub(super) fn fit_full(app:&tauri::AppHandle,window:&tauri::WebviewWindow,width:f64,height:f64)->Result<(),String> {
    if window.label()!="plugin-canvas" {return Err("仅可调整桌面组件窗口".into());}
    let state=app.state::<super::State>();let store=&state.compact;
    if store.busy_or_compact(){return Err("紧凑入口不能调整画布尺寸".into());}
    let (mut next,generation)=store.begin()?;let mut rollback=None;
    let result=(||->Result<(),String>{
        let available=displays(app)?;let (display,actual)=sampled(window,&available)?;rollback=Some((display.clone(),actual.clone()));
        let width=(width.max(360.)*display.scale).round().clamp(1.,display.width as f64) as u32;
        let height=(height.max(200.)*display.scale).round().clamp(1.,display.height as f64) as u32;
        let target=restore(Some(&geometry(&display,actual.x,actual.y,width,height,None)),&display,false);
        apply(window,&target,&display,false)?;
        let (display,applied)=sampled(window,&available)?;ensure_applied(&target,&applied)?;
        next.geometries.insert(slot(&display.key,false),applied);next.displays.insert("full".into(),display.key);
        store.finish(generation,Some(next))
    })();
    if let Err(error)=result {
        let rollback_error=rollback.and_then(|(display,actual)|apply(window,&actual,&display,false).err());
        let _=store.finish(generation,None);
        return Err(if let Some(rollback)=rollback_error {format!("{error}；恢复窗口失败：{rollback}")}else{error});
    }
    Ok(())
}
pub(super) fn popup(app:&tauri::AppHandle,origin:&str)->Result<Presentation,String> {
    use tauri::menu::{CheckMenuItem,ContextMenu,MenuBuilder};
    if origin!="plugin-canvas" {return Err("紧凑入口来源无效".into());}
    let state=app.state::<super::State>();let layout=state.layout.lock().unwrap().clone();let presentation=state.compact.presentation(&layout);
    if !presentation.compact(){return Err("仅可打开紧凑入口菜单".into());}
    let window=app.get_webview_window("plugin-canvas").ok_or("桌面组件窗口已关闭")?;
    let pinned=CheckMenuItem::with_id(app,"canvas-compact:pin","窗口置顶",true,layout.pinned,None::<&str>).map_err(|e|e.to_string())?;
    let menu=MenuBuilder::new(app).text("canvas-compact:left","贴左边").text("canvas-compact:right","贴右边")
        .text("canvas-compact:top","贴上边").text("canvas-compact:bottom","贴下边").separator().item(&pinned).text("canvas-compact:hide","隐藏状态条").build().map_err(|e|e.to_string())?;
    menu.popup(window.as_ref().window()).map_err(|e|e.to_string())?;
    let presentation=state.compact.presentation(&state.layout.lock().unwrap());Ok(presentation)
}
pub(super) fn install_menu(window:&tauri::WebviewWindow) {
    window.on_menu_event(|window,event|{
        if window.label()!="plugin-canvas" {return;}
        let Some(command)=event.id().0.strip_prefix("canvas-compact:") else{return;};
        let command=command.to_string();let app=window.app_handle().clone();
        let result=on_main(&app,move|app|{
            let state=app.state::<super::State>();
            if !state.compact.presentation(&state.layout.lock().unwrap()).compact(){return Err("状态条模式已变化，请重新打开菜单".into());}
            let window=app.get_webview_window("plugin-canvas").ok_or("桌面组件窗口已关闭")?;
            if ["left","right","top","bottom"].contains(&command.as_str()) {
                action(app,"plugin-canvas","snapCompact",json!({"edge":command}))?;
            } else if command=="pin" {
                let old=state.layout.lock().unwrap().pinned;let pinned=!old;
                window.set_always_on_top(pinned).map_err(|e|e.to_string())?;
                if let Err(error)=state.update(|layout|layout.pinned=pinned){let _=window.set_always_on_top(old);return Err(error);}
                for label in ["plugin-canvas","settings"] {if let Some(w)=app.get_webview_window(label) {
                    let _=w.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-pinned',{{detail:{pinned}}}))"));
                }}
            } else if command=="hide" {
                state.update(|layout|layout.desktop=true)?;window.hide().map_err(|e|e.to_string())?;super::lifecycle::sample(app,&window);
            }
            Ok(())
        });
        if let Err(error)=result {if let Some(window)=app.get_webview_window("plugin-canvas") {
            let _=window.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-error',{{detail:{}}}))",json!(error)));
        }}
    });
}
fn publish(app:&tauri::AppHandle,presentation:&Presentation) {
    for label in ["plugin-canvas","settings"] {if let Some(window)=app.get_webview_window(label) {
        let _=window.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-presentation',{{detail:{}}}))",json!(presentation)));
    }}
}

fn intersects_workarea(frame:&Geometry,display:&Display)->bool {
    // Each monitor's "physical" global coordinates use its own scale on macOS.
    // Compare in one logical global space, including negative monitor origins.
    let (x,y,w,h)=(frame.x as f64/frame.scale,frame.y as f64/frame.scale,frame.width as f64/frame.scale,frame.height as f64/frame.scale);
    let (left,top,width,height)=(display.x as f64/display.scale,display.y as f64/display.scale,display.width as f64/display.scale,display.height as f64/display.scale);
    x<left+width && x+w>left && y<top+height && y+h>top
}
fn entirely_offscreen(frame:&Geometry,available:&[Display])->bool {!available.is_empty() && available.iter().all(|display|!intersects_workarea(frame,display))}

#[cfg(target_os="macos")]
fn recover_offscreen(app:&tauri::AppHandle,epoch:&TopologyEpoch,revision:u64)->Result<(),String> {
    if !epoch.current(revision){return Ok(());}
    let Some(window)=app.get_webview_window("plugin-canvas") else{return Ok(());};
    let available=displays(app)?;let (display,actual)=sampled(&window,&available)?;
    if !epoch.current(revision) || !entirely_offscreen(&actual,&available){return Ok(());}
    let state=app.state::<super::State>();let store=&state.compact;
    if store.inner.lock().unwrap().transitioning {return Ok(());}
    let (mut next,generation)=store.begin()?;let compact=next.presentation.compact();
    let result=(||->Result<(),String>{
        // Use the previously saved mode/display target. Do not first record the
        // disconnected frame into a surviving monitor's slot.
        if !epoch.current(revision){return store.finish(generation,None);}
        restore_saved(&window,app,&next)?;
        let (target,mut applied)=sampled(&window,&available)?;
        applied.edge=next.geometries.get(&slot(&target.key,compact)).and_then(|g|g.edge);
        next.geometries.insert(slot(&target.key,compact),applied);next.displays.insert(mode(compact).into(),target.key);
        store.finish(generation,Some(next))
    })();
    if let Err(error)=result {
        let rollback=apply(&window,&actual,&display,compact).err();let _=store.finish(generation,None);
        return Err(if let Some(rollback)=rollback {format!("{error}；恢复窗口失败：{rollback}")}else{error});
    }
    Ok(())
}

#[cfg(any(target_os="macos",test))]
struct CallbackRegistry<T> { next:std::sync::atomic::AtomicUsize, entries:Mutex<HashMap<usize,std::sync::Arc<T>>> }
#[cfg(any(target_os="macos",test))]
impl<T> CallbackRegistry<T> {
    fn new()->Self {Self{next:std::sync::atomic::AtomicUsize::new(1),entries:Mutex::new(HashMap::new())}}
    fn insert(&self,value:std::sync::Arc<T>)->usize {let id=self.next.fetch_add(1,std::sync::atomic::Ordering::Relaxed);self.entries.lock().unwrap().insert(id,value);id}
    fn get(&self,id:usize)->Option<std::sync::Arc<T>> {self.entries.lock().unwrap().get(&id).cloned()}
    fn remove(&self,id:usize)->Option<std::sync::Arc<T>> {self.entries.lock().unwrap().remove(&id)}
}
#[cfg(any(target_os="macos",test))]
struct TopologyEpoch { active:std::sync::atomic::AtomicBool, revision:std::sync::atomic::AtomicU64 }
#[cfg(any(target_os="macos",test))]
impl TopologyEpoch {
    fn new()->Self {Self{active:std::sync::atomic::AtomicBool::new(true),revision:std::sync::atomic::AtomicU64::new(0)}}
    fn changed(&self,begin:bool)->Option<u64> {
        let revision=self.revision.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1;
        (!begin && self.active.load(std::sync::atomic::Ordering::SeqCst)).then_some(revision)
    }
    fn current(&self,revision:u64)->bool {self.active.load(std::sync::atomic::Ordering::SeqCst) && self.revision.load(std::sync::atomic::Ordering::SeqCst)==revision}
    fn stop(&self) {self.active.store(false,std::sync::atomic::Ordering::SeqCst);self.revision.fetch_add(1,std::sync::atomic::Ordering::SeqCst);}
}
#[cfg(target_os="macos")]
struct TopologyWatch { app:tauri::AppHandle, epoch:TopologyEpoch }
#[cfg(target_os="macos")]
fn topology_registry()->&'static CallbackRegistry<TopologyWatch> {
    static REGISTRY:std::sync::OnceLock<CallbackRegistry<TopologyWatch>>=std::sync::OnceLock::new();REGISTRY.get_or_init(CallbackRegistry::new)
}
#[cfg(target_os="macos")]
unsafe extern "C" fn topology_changed(_:u32,flags:u32,context:*const std::ffi::c_void) {
    // The opaque context is an integer token, never a dereferenced pointer. An
    // in-flight callback keeps its Arc; unregister can safely remove the token.
    let Some(watch)=topology_registry().get(context as usize) else{return;};
    let begin=flags & core_graphics::display::CGDisplayChangeSummaryFlags::kCGDisplayBeginConfigurationFlag.bits()!=0;
    let Some(revision)=watch.epoch.changed(begin) else{return;};
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if !watch.epoch.current(revision){return;}
        let app=watch.app.clone();let handle=app.clone();
        let _=app.run_on_main_thread(move||{
            if !watch.epoch.current(revision){return;}
            if let Err(error)=recover_offscreen(&handle,&watch.epoch,revision) {if watch.epoch.current(revision) {if let Some(window)=handle.get_webview_window("plugin-canvas") {
                let _=window.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-error',{{detail:{}}}))",json!(error)));
            }}}
        });
    });
}
pub(super) fn watch_displays(app:&tauri::AppHandle)->Result<(),String> {
    #[cfg(target_os="macos")]
    {
        let state=app.state::<super::State>();
        if state.compact.inner.lock().unwrap().topology_token.is_some(){return Ok(());}
        let watch=std::sync::Arc::new(TopologyWatch{app:app.clone(),epoch:TopologyEpoch::new()});
        let id=topology_registry().insert(watch);
        let result=unsafe{core_graphics::display::CGDisplayRegisterReconfigurationCallback(topology_changed,id as *const std::ffi::c_void)};
        if result!=0 {if let Some(watch)=topology_registry().remove(id){watch.epoch.stop();}return Err(format!("无法监听显示器变化：{result}"));}
        state.compact.inner.lock().unwrap().topology_token=Some(id);
    }
    #[cfg(not(target_os="macos"))]
    let _=app; // Other platforms currently recover on explicit reopen only.
    Ok(())
}
pub(super) fn window_destroyed(app:&tauri::AppHandle) {
    let state=app.state::<super::State>();
    let id=state.compact.inner.lock().unwrap().topology_token.take();
    #[cfg(target_os="macos")]
    if let Some(id)=id {
        if let Some(watch)=topology_registry().remove(id){watch.epoch.stop();}
        let _=unsafe{core_graphics::display::CGDisplayRemoveReconfigurationCallback(topology_changed,id as *const std::ffi::c_void)};
    }
    #[cfg(not(target_os="macos"))]
    let _=id;
    state.compact.end_window_session();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root()->PathBuf {
        let root=std::env::temp_dir().join(format!("canvas-compact-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();root
    }
    fn display()->Display {Display{key:"cg:stable-display".into(),x:-1920,y:-900,width:1920,height:1080,scale:1.}}
    fn layout()->super::super::Layout {
        let mut layout=super::super::Layout::default();
        layout.boards[0].cards.push(serde_json::from_value(json!({"id":"card","plugin":"machines","title":"CPU","view":"widget","size":"small"})).unwrap());layout
    }
    #[test]
    fn independent_presentation_survives_legacy_and_stale_layout_saves() {
        let root=root();let state=super::super::State::new(&root).unwrap();
        assert_eq!(state.compact.presentation(&layout()),Presentation::default());
        assert!(!root.join("canvas-presentation.json").exists());
        let (mut saved,generation)=state.compact.begin().unwrap();
        saved.presentation=Presentation{enabled:true,collapsed:true,favorites:vec![Favorite{board_id:"default".into(),card_id:"card".into()}],revision:4};
        let d=display();saved.geometries.insert(slot(&d.key,true),restore(None,&d,true));
        state.compact.finish(generation,Some(saved)).unwrap();
        let before=std::fs::read(root.join("canvas-presentation.json")).unwrap();
        let mut legacy=layout();legacy.layout_locked=true;legacy.view_only=true;state.save(legacy.clone()).unwrap();
        state.save_from_canvas(legacy.clone()).unwrap();
        assert_eq!(std::fs::read(root.join("canvas-presentation.json")).unwrap(),before);
        let reopened=super::super::State::new(&root).unwrap();
        assert!(reopened.compact.presentation(&legacy).compact());assert_eq!(reopened.compact.presentation(&legacy).revision,4);
        let persisted:Value=serde_json::from_slice(&std::fs::read(root.join("plugin-canvas.json")).unwrap()).unwrap();
        assert!(persisted.get("presentation").is_none());assert!(persisted.get("collapsed").is_none());
        legacy.boards[0].cards.clear();assert!(reopened.compact.presentation(&legacy).favorites.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn appkit_full_position_and_compact_geometry_survive_stale_canvas_saves() {
        let root=root();let state=super::super::State::new(&root).unwrap();
        state.remember_appkit_position((472.5,1902.)).unwrap();
        let d=display();let compact=restore(None,&d,true);
        let (mut saved,generation)=state.compact.begin().unwrap();
        saved.presentation.enabled=true;saved.presentation.collapsed=true;
        saved.geometries.insert(slot(&d.key,true),compact.clone());
        state.compact.finish(generation,Some(saved)).unwrap();
        let mut stale=layout();stale.window_position_appkit=Some((0.,900.));
        state.save_from_canvas(stale).unwrap();
        let reopened=super::super::State::new(&root).unwrap();
        assert_eq!(reopened.layout.lock().unwrap().window_position_appkit,Some((472.5,1902.)));
        assert!(reopened.compact.presentation(&layout()).compact());
        assert_eq!(reopened.compact.inner.lock().unwrap().saved.geometries.get(&slot(&d.key,true)),Some(&compact));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn geometry_preserves_logical_size_and_relative_position_across_scale_and_workarea_changes() {
        let d=Display{scale:2.,width:2880,height:1800,x:0,y:46,..display()};
        let g=geometry(&d,700,800,1040,128,Some(Edge::Right));
        let changed=Display{scale:1.,x:-1800,y:-1080,width:1800,height:1000,..d.clone()};
        let restored=restore(Some(&g),&changed,true);
        assert_eq!((restored.width,restored.height),(520,64));
        assert_eq!(restored.x,changed.x+changed.width as i32-520);
        assert!(restored.y>=changed.y&&restored.y+64<=changed.y+changed.height as i32);
        let full=restore(None,&changed,false);assert_eq!((full.width,full.height),(1040,720));
        let tiny=Display{width:250,height:50,..changed};let fit=restore(Some(&g),&tiny,true);
        assert_eq!((fit.x,fit.y,fit.width,fit.height),(tiny.x,tiny.y,250,50));
        for edge in [Edge::Left,Edge::Right,Edge::Top,Edge::Bottom] {
            let g=Geometry{edge:Some(edge),..g.clone()};let r=restore(Some(&g),&d,true);
            match edge {Edge::Left=>assert_eq!(r.x,d.x),Edge::Right=>assert_eq!(r.x+r.width as i32,d.x+d.width as i32),Edge::Top=>assert_eq!(r.y,d.y),Edge::Bottom=>assert_eq!(r.y+r.height as i32,d.y+d.height as i32)}
        }
    }
    #[test]
    fn display_and_mode_slots_survive_rearrangement_and_disconnection() {
        let a=display();let b=Display{key:"cg:second".into(),x:0,y:0,scale:2.,..a.clone()};
        let mut saved=Saved::default();saved.displays.insert("compact".into(),a.key.clone());saved.displays.insert("full".into(),b.key.clone());
        let moved=Display{x:1000,y:-1800,scale:2.,..a.clone()};let available=vec![b.clone(),moved.clone()];
        assert_eq!(target_display(&saved,&available,true,&b).key,a.key);
        assert_eq!(target_display(&saved,&available,false,&moved).key,b.key);
        assert_eq!(target_display(&saved,&[b.clone()],true,&a).key,b.key);
        assert_ne!(slot(&a.key,true),slot(&a.key,false));
    }
    #[test]
    fn native_origin_config_and_disabled_mode_validation_is_authoritative() {
        let layout=layout();let p=Presentation::default();
        assert!(plan(&p,&layout,"setCompact",json!({"collapsed":true})).is_err());
        assert!(plan(&p,&layout,"snapCompact",json!({"edge":"left"})).is_err());
        let favorite=json!({"boardId":"default","cardId":"card"});
        let (enabled,_)=plan(&p,&layout,"configureCompact",json!({"enabled":true,"favorites":[favorite]})).unwrap();
        assert!(enabled.enabled);assert!(!enabled.collapsed);assert_eq!(enabled.revision,1);
        let (collapsed,_)=plan(&enabled,&layout,"setCompact",json!({"collapsed":true})).unwrap();
        let (disabled,_)=plan(&collapsed,&layout,"configureCompact",json!({"enabled":false,"favorites":[]})).unwrap();
        assert!(!disabled.enabled);assert!(!disabled.collapsed);assert_eq!(disabled.revision,3);
        for bad in [json!({"enabled":true,"favorites":[favorite,favorite]}),json!({"enabled":true,"favorites":[{"boardId":"other","cardId":"card"}]}),json!({"enabled":true,"favorites":[],"collapsed":true})] {
            assert!(plan(&p,&layout,"configureCompact",bad).is_err());
        }
        assert!(allowed("settings","configureCompact"));assert!(!allowed("settings","setCompact"));
        for label in ["widget-detail-1","plugin-machines","other"] {for action in ["configureCompact","setCompact","snapCompact"] {assert!(!allowed(label,action));}}
    }
    #[test]
    fn generations_suppress_delayed_events_and_failed_commits_release_the_reservation() {
        let root=root();let store=Store::new(&root).unwrap();let d=display();
        let (mut first,oldgen)=store.begin().unwrap();assert!(store.begin().is_err());
        store.record(oldgen,&d,restore(None,&d,false)).unwrap();assert!(store.inner.lock().unwrap().saved.geometries.is_empty());
        first.presentation.enabled=true;first.presentation.collapsed=true;first.presentation.revision=1;
        // Force the real atomic rename to fail, without changing user files.
        std::fs::create_dir(&store.path).unwrap();assert!(store.finish(oldgen,Some(first.clone())).is_err());
        assert!(!store.inner.lock().unwrap().saved.presentation.enabled);assert!(store.busy_or_compact());
        store.finish(oldgen,None).unwrap();assert!(!store.busy_or_compact());std::fs::remove_dir(&store.path).unwrap();
        let (_,newgen)=store.begin().unwrap();assert!(newgen>oldgen);store.finish(newgen,Some(first)).unwrap();
        store.record(oldgen,&d,restore(None,&d,false)).unwrap();assert!(store.inner.lock().unwrap().saved.geometries.is_empty());
        let compact=restore(None,&d,true);store.record(newgen,&d,compact.clone()).unwrap();
        let inner=store.inner.lock().unwrap();assert_eq!(inner.saved.geometries.get(&slot(&d.key,true)),Some(&compact));assert!(!inner.saved.geometries.contains_key(&slot(&d.key,false)));drop(inner);
        assert_eq!(Store::new(&root).unwrap().inner.lock().unwrap().saved.presentation.revision,1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unapplied_or_deferred_frame_is_rejected_before_mode_commit() {
        let root=root();let store=Store::new(&root).unwrap();let d=display();
        let (mut next,generation)=store.begin().unwrap();next.presentation.enabled=true;next.presentation.collapsed=true;next.presentation.revision=1;
        let compact=restore(None,&d,true);let old_actual=restore(None,&d,false);
        assert!(ensure_applied(&compact,&old_actual).is_err());
        // This is the failure path used by transition(): no compact snapshot is
        // published or persisted until actual native geometry matches the plan.
        store.finish(generation,None).unwrap();assert!(!store.inner.lock().unwrap().saved.presentation.collapsed);
        assert!(!store.path.exists());
        let (_,generation)=store.begin().unwrap();ensure_applied(&compact,&compact).unwrap();
        next.geometries.insert(slot(&d.key,true),compact);store.finish(generation,Some(next)).unwrap();
        assert_eq!(store.inner.lock().unwrap().saved.geometries.get(&slot(&d.key,true)).unwrap().height,64);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn appkit_conversion_and_free_drag_release_snap_without_reusing_full_geometry() {
        let root=root();let store=Store::new(&root).unwrap();let d=display();
        let (mut saved,generation)=store.begin().unwrap();saved.presentation.enabled=true;saved.presentation.collapsed=true;
        let snapped=Geometry{edge:Some(Edge::Right),..restore(None,&d,true)};
        saved.geometries.insert(slot(&d.key,true),snapped.clone());store.finish(generation,Some(saved)).unwrap();
        let moved=geometry(&d,-1700,-700,520,64,None);store.record(generation,&d,moved.clone()).unwrap();
        let stored=store.inner.lock().unwrap().saved.geometries.get(&slot(&d.key,true)).cloned().unwrap();
        assert_eq!(stored.edge,None);assert_eq!(restore(Some(&stored),&d,true).x,moved.x);
        let scaled=Geometry{x:1000,y:-1200,width:1040,height:128,scale:2.,nx:0.,ny:0.,edge:None};
        assert_eq!(appkit_rect(&scaled,900.),(500.,1436.,520.,64.));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disabled_persisted_config_cannot_restore_collapsed_mode() {
        let root=root();std::fs::write(root.join("canvas-presentation.json"),r#"{"enabled":false,"collapsed":true,"favorites":[],"revision":7}"#).unwrap();
        let store=Store::new(&root).unwrap();let p=store.presentation(&layout());assert!(!p.enabled);assert!(!p.collapsed);assert_eq!(p.revision,7);
        assert!(!store.busy_or_compact());std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn initial_fit_marker_requires_full_geometry_saved_before_this_full_window_session() {
        let root=root();let store=Store::new(&root).unwrap();let d=display();
        store.start_window_session();assert!(!store.window_geometry_restored());
        let (mut saved,generation)=store.begin().unwrap();saved.geometries.insert(slot(&d.key,false),restore(None,&d,false));store.finish(generation,Some(saved)).unwrap();
        store.start_window_session();assert!(!store.window_geometry_restored(),"new/default geometry written during startup must not retroactively suppress initial fit");
        store.end_window_session();store.start_window_session();assert!(store.window_geometry_restored());
        assert!(store.window_geometry_restored(),"get/poll reads do not consume the session flag");
        store.end_window_session();
        let (mut saved,generation)=store.begin().unwrap();saved.presentation.enabled=true;saved.presentation.collapsed=true;store.finish(generation,Some(saved)).unwrap();
        store.start_window_session();assert!(!store.window_geometry_restored(),"compact startup must not suppress a later full-mode content resize");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn offscreen_detection_uses_common_logical_space_and_preserves_partial_visibility() {
        let primary=Display{key:"primary".into(),x:0,y:76,width:3024,height:1888,scale:2.};
        let above=Display{key:"above".into(),x:-202,y:-1080,width:1920,height:993,scale:1.};
        let screens=vec![primary.clone(),above.clone()];
        let above_frame=Geometry{x:-300,y:-2000,width:1040,height:128,scale:2.,nx:0.,ny:0.,edge:None};
        assert!(!entirely_offscreen(&above_frame,&screens),"window scale can differ from a surviving display; compare after dividing each independently");
        let one_pixel=Geometry{x:3022,y:80,width:1040,height:128,scale:2.,..above_frame.clone()};
        assert!(!entirely_offscreen(&one_pixel,&screens));
        let outside=Geometry{x:8000,y:8000,..one_pixel};assert!(entirely_offscreen(&outside,&screens));
        assert!(!entirely_offscreen(&outside,&[]),"an intermediate zero-screen topology must not trigger recovery");
    }
    #[test]
    fn topology_tokens_and_epochs_cancel_begin_notifications_and_inflight_destroyed_callbacks() {
        let registry=CallbackRegistry::new();let epoch=std::sync::Arc::new(TopologyEpoch::new());let weak=std::sync::Arc::downgrade(&epoch);
        let id=registry.insert(epoch.clone());let callback=registry.get(id).unwrap();
        let first=callback.changed(false).unwrap();assert!(callback.current(first));
        assert_eq!(callback.changed(true),None);assert!(!callback.current(first));
        let end=callback.changed(false).unwrap();assert!(callback.current(end),"flags=0 end notification remains valid");
        let removed=registry.remove(id).unwrap();removed.stop();drop(removed);drop(epoch);
        assert!(registry.get(id).is_none());assert!(!callback.current(end));assert!(weak.upgrade().is_some(),"in-flight callback owns a safe Arc after unregister");
        let new_id=registry.insert(std::sync::Arc::new(TopologyEpoch::new()));assert_ne!(id,new_id);assert!(registry.get(id).is_none());
        drop(callback);assert!(weak.upgrade().is_none(),"callback state is freed after its final in-flight operation ends");
    }
}
