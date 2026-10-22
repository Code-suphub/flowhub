use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[path = "detail.rs"]
mod detail;

#[cfg(any(target_os="macos",test))]
fn viewport_point(x:f64,y:f64,left:f64,bottom:f64,height:f64,flipped:bool)->(f64,f64){
    (x-left,if flipped{y-bottom}else{height-(y-bottom)})
}
#[cfg(any(not(target_os="macos"),test))]
fn position_is_visible((x,y):(i32,i32),monitors:&[(i32,i32,u32,u32)])->bool {
    monitors.iter().any(|&(left,top,width,height)| {
        let (x,y,left,top)=(x as i64,y as i64,left as i64,top as i64);
        x>=left && y>=top && x+80<=left+width as i64 && y+80<=top+height as i64
    })
}
#[cfg(any(target_os="macos",test))]
fn appkit_position_is_visible((x,y):(f64,f64),frames:&[(f64,f64,f64,f64)])->bool {
    x.is_finite() && y.is_finite() && frames.iter().any(|&(left,bottom,width,height)|
        x>=left && x+80.<=left+width && y-80.>=bottom && y<=bottom+height)
}
#[cfg(any(target_os="macos",test))]
fn legacy_appkit_position((x,y):(i32,i32),primary_height:f64,screens:&[(f64,f64,f64,f64,f64)])->Option<(f64,f64)> {
    screens.iter().find_map(|&(left,bottom,width,height,scale)|{
        let point=(x as f64/scale,primary_height-y as f64/scale);
        appkit_position_is_visible(point,&[(left,bottom,width,height)]).then_some(point)
    })
}
#[cfg(test)]
mod cursor_tests {
    use super::viewport_point;
    #[test]
    fn appkit_local_points_map_to_top_left_without_screen_scale(){
        assert_eq!(viewport_point(30.,370.,0.,0.,400.,false),(30.,30.));
        assert_eq!(viewport_point(30.,30.,0.,0.,400.,true),(30.,30.));
        assert_eq!(viewport_point(40.,380.,10.,10.,400.,false),(30.,30.));
        assert_eq!(viewport_point(-20.,450.,0.,0.,400.,false),(-20.,-50.));
        assert_eq!(viewport_point(640.,-10.,0.,0.,400.,false),(640.,410.));
    }
}
#[cfg(target_os="macos")]
async fn canvas_cursor(window:&tauri::WebviewWindow)->Result<Value,String>{
    let (tx,rx)=tokio::sync::oneshot::channel();
    window.with_webview(move |webview|{
        // AppKit provides window-local points, independent of screen origins and DPI.
        // with_webview runs on the main thread; WKWebView inherits NSView.
        let result=unsafe{
            let native=&*webview.ns_window().cast::<objc2_app_kit::NSWindow>();
            let view=&*webview.inner().cast::<objc2_app_kit::NSView>();
            let point=view.convertPoint_fromView(native.mouseLocationOutsideOfEventStream(),None);
            let bounds=view.bounds();
            let (x,y)=viewport_point(point.x,point.y,bounds.origin.x,bounds.origin.y,bounds.size.height,view.isFlipped());
            let frontmost=objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication()
                .is_some_and(|application| application.processIdentifier()==std::process::id() as i32);
            json!({"x":x,"y":y,"frontmost":frontmost})
        };
        let _=tx.send(result);
    }).map_err(|e|e.to_string())?;
    rx.await.map_err(|_|"无法读取画布鼠标位置".into())
}
#[cfg(not(target_os="macos"))]
async fn canvas_cursor(window:&tauri::WebviewWindow)->Result<Value,String>{
    let cursor=window.cursor_position().map_err(|e|e.to_string())?;
    let origin=window.inner_position().map_err(|e|e.to_string())?;
    let scale=window.scale_factor().map_err(|e|e.to_string())?;
    Ok(json!({"x":(cursor.x-origin.x as f64)/scale,"y":(cursor.y-origin.y as f64)/scale,"frontmost":true}))
}
#[tauri::command]
pub async fn plugin_widget_rpc(window:tauri::WebviewWindow,app:tauri::AppHandle,id:String,params:Value)->Result<Value,String>{
    if window.label()!="plugin-canvas" {
        let state=app.state::<State>();
        let details=state.details.lock().unwrap();
        if !details.owns(window.label(),&id){return Err("组件调用来源无效".into());}
    }
    app.state::<crate::plugin::runtime::Runtime>().widget_call(&id,params).await
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Card { id:String, plugin:String, title:String, view:String, size:String, #[serde(default)] row:Option<String>, #[serde(default)] width:Option<u32>, #[serde(default)] height:Option<u32>, #[serde(default)] break_before:bool, #[serde(default)] x:Option<u32>, #[serde(default)] y:Option<u32>, #[serde(default)] metrics:Option<Vec<String>>, #[serde(default)] config:Value }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Board { id:String, title:String, cards:Vec<Card> }
#[derive(Clone, Serialize, Deserialize)]
pub struct Layout { boards:Vec<Board>, active:String, pinned:bool, #[serde(default,rename="viewOnly")] view_only:bool, #[serde(default,rename="layoutLocked")] layout_locked:bool, #[serde(default)] desktop:bool, #[serde(default,rename="windowPosition",skip_serializing_if="Option::is_none")] window_position:Option<(i32,i32)>, #[serde(default,rename="windowPositionAppKit",skip_serializing_if="Option::is_none")] window_position_appkit:Option<(f64,f64)>, #[serde(default)] version:u32 }
impl Default for Layout {fn default()->Self{Self{boards:vec![Board{id:"default".into(),title:"我的工作台".into(),cards:vec![]}],active:"default".into(),pinned:false,view_only:false,layout_locked:false,desktop:false,window_position:None,window_position_appkit:None,version:2}}}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Presentation { active:String, pinned:bool }
impl Layout {
    fn validate(&self)->Result<(),String>{
        if self.window_position_appkit.is_some_and(|(x,y)|!x.is_finite()||!y.is_finite()){return Err("窗口位置无效".into());}
        if self.boards.is_empty() || self.boards.len()>12 || !self.boards.iter().any(|b|b.id==self.active){return Err("画布数量或当前画布无效".into());}
        let mut ids=std::collections::HashSet::new();
        for b in &self.boards {
            if b.id.is_empty()||b.id.len()>80||!ids.insert(&b.id)||b.title.trim().is_empty()||b.title.len()>120||b.cards.len()>32{return Err("画布配置无效".into());}
            let mut cards=std::collections::HashSet::new();
            for c in &b.cards { if !c.config.is_null() && (!c.config.is_object() || c.config.to_string().len()>65536){return Err("组件配置无效".into());} if c.metrics.as_ref().is_some_and(|m|m.len()>64||m.iter().any(|v|v.len()>80)){return Err("显示指标无效".into());} if c.x.is_some_and(|v|v>52000)||c.y.is_some_and(|v|v>52000){return Err("组件位置超出范围".into());} if c.width.is_some_and(|v| !(160..=1600).contains(&v)) || c.height.is_some_and(|v| !(120..=1200).contains(&v)) { return Err("组件尺寸超出范围".into()); } }
            for c in &b.cards{if c.id.is_empty()||c.id.len()>80||!cards.insert(&c.id)||c.plugin.is_empty()||c.plugin.len()>128||c.title.len()>120||c.row.as_ref().is_some_and(|r|r.len()>128)||c.view.is_empty()||c.view.len()>80||!["small","medium","large"].contains(&c.size.as_str()){return Err("组件配置无效".into());}}
        } Ok(())
    }
}
pub struct State { path:PathBuf, layout:Mutex<Layout>, details:Mutex<detail::Registry>, return_target:Mutex<Option<detail::ReturnTarget>> }
impl State {
    pub fn new(root:&std::path::Path)->Result<Self,String>{let path=root.join("plugin-canvas.json");let layout=match std::fs::read(&path){Ok(b)=>serde_json::from_slice::<Layout>(&b).map_err(|e|e.to_string())?,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Layout::default(),Err(e)=>return Err(e.to_string())};layout.validate()?;Ok(Self{path,layout:Mutex::new(layout),details:Mutex::new(detail::Registry::default()),return_target:Mutex::new(None)})}
    fn try_update(&self, change:impl FnOnce(&mut Layout)->Result<(),String>)->Result<(),String>{let mut layout=self.layout.lock().unwrap();let mut next=layout.clone();change(&mut next)?;next.validate()?;crate::storage::write_json_atomic(&self.path,&json!(next))?;*layout=next;Ok(())}
    fn update(&self, change:impl FnOnce(&mut Layout))->Result<(),String>{self.try_update(|layout|{change(layout);Ok(())})}
    #[cfg(test)]
    fn save(&self, next:Layout)->Result<(),String>{self.update(|layout|*layout=next)}
    fn save_from_canvas(&self,next:Layout)->Result<(),String>{
        self.try_update(|layout|{
            if (layout.layout_locked || layout.view_only) && layout.boards!=next.boards {return Err("布局已锁定，无法编辑组件或布局".into());}
            // Frontend snapshots may predate a native move or mode change.
            let owned=(layout.view_only,layout.layout_locked,layout.desktop,layout.window_position,layout.window_position_appkit);
            *layout=next;
            layout.view_only=owned.0;layout.layout_locked=owned.1;layout.desktop=owned.2;layout.window_position=owned.3;layout.window_position_appkit=owned.4;
            Ok(())
        })
    }
    fn save_presentation(&self,presentation:Presentation)->Result<(),String>{
        self.update(|layout|{layout.active=presentation.active;layout.pinned=presentation.pinned;})
    }
    fn return_to_source(&self,request:&detail::Request)->Result<(),String>{
        self.try_update(|layout|{
            detail::validate_source(layout,&request.board_id,&request.card_id,&request.plugin)?;
            layout.active=request.board_id.clone();
            Ok(())
        })
    }
    fn prepare_open(&self,plugin:&str)->Result<bool,String>{
        let mut added=false;
        self.update(|layout|{
            if !layout.layout_locked && !layout.view_only && !plugin.is_empty() && !layout.boards.iter().any(|b|b.cards.iter().any(|c|c.plugin==plugin)) {
                let board=layout.boards.iter_mut().find(|b|b.id==layout.active).unwrap();
                if board.cards.len()<32{board.cards.push(Card{id:format!("widget-{}",chrono::Utc::now().timestamp_millis()),plugin:plugin.into(),title:String::new(),view:"widget".into(),size:"small".into(),row:None,width:None,height:None,break_before:false,x:None,y:None,metrics:None,config:Value::Null});added=true;}
            }
            layout.desktop=true;
        })?;
        Ok(added)
    }
    #[cfg(any(not(target_os="macos"),test))]
    fn remember_position(&self,position:(i32,i32))->Result<(),String>{
        if self.layout.lock().unwrap().window_position==Some(position){return Ok(());}
        self.update(|layout|layout.window_position=Some(position))
    }
    #[cfg(any(target_os="macos",test))]
    fn remember_appkit_position(&self,position:(f64,f64))->Result<(),String>{
        if self.layout.lock().unwrap().window_position_appkit==Some(position){return Ok(());}
        self.update(|layout|layout.window_position_appkit=Some(position))
    }
}
#[cfg(target_os="macos")]
fn capture_canvas_position(window:&tauri::WebviewWindow) {
    let app=window.app_handle().clone();
    let _=window.with_webview(move|webview|{
        let native=unsafe{&*webview.ns_window().cast::<objc2_app_kit::NSWindow>()};
        let frame=native.frame();
        let _=app.state::<State>().remember_appkit_position((frame.origin.x,frame.origin.y+frame.size.height));
    });
}
#[cfg(target_os="macos")]
fn show_canvas(window:&tauri::WebviewWindow,layout:Layout)->Result<(),String>{
    let handle=window.clone();
    window.with_webview(move|webview|{
        let Some(mtm)=objc2::MainThreadMarker::new() else{return;};
        let native=unsafe{&*webview.ns_window().cast::<objc2_app_kit::NSWindow>()};
        let screens=objc2_app_kit::NSScreen::screens(mtm);
        let frames:Vec<_>=screens.iter().map(|s|{let f=s.frame();(f.origin.x,f.origin.y,f.size.width,f.size.height)}).collect();
        let legacy_screens:Vec<_>=screens.iter().map(|s|{let f=s.frame();(f.origin.x,f.origin.y,f.size.width,f.size.height,s.backingScaleFactor())}).collect();
        let restored=layout.window_position_appkit.filter(|p|appkit_position_is_visible(*p,&frames))
            .or_else(||if layout.window_position_appkit.is_none(){layout.window_position.and_then(|p|legacy_appkit_position(p,core_graphics::display::CGDisplay::main().pixels_high() as f64,&legacy_screens))}else{None});
        if let Some((x,y))=restored {
            native.setFrameTopLeftPoint(objc2_foundation::NSPoint::new(x,y));
        } else if layout.window_position_appkit.is_some()||layout.window_position.is_some() {
            if let Some(screen)=screens.firstObject(){
                let bounds=screen.visibleFrame();let size=native.frame().size;
                native.setFrameTopLeftPoint(objc2_foundation::NSPoint::new(bounds.origin.x+((bounds.size.width-size.width)/2.).max(0.),bounds.origin.y+bounds.size.height-((bounds.size.height-size.height)/2.).max(0.)));
            }
        }
        // Save and show in the same main-thread operation, before DPI/move events.
        let frame=native.frame();
        let _=handle.app_handle().state::<State>().remember_appkit_position((frame.origin.x,frame.origin.y+frame.size.height));
        let _=handle.show();let _=handle.set_focus();
    }).map_err(|e|e.to_string())
}
pub fn open(app:&tauri::AppHandle,plugin:&str)->Result<(),String>{
    open_with_source(app,plugin,None)
}
fn open_with_source(app:&tauri::AppHandle,plugin:&str,source:Option<detail::ReturnTarget>)->Result<(),String>{
    let state=app.state::<State>();let added=state.prepare_open(plugin)?;
    if let Some(target)=&source {*state.return_target.lock().unwrap()=Some(target.clone());}
    let layout=state.layout.lock().unwrap().clone();
    let source_url=source.as_ref().map(|target|format!("plugin-canvas.html?{}",url::form_urlencoded::Serializer::new(String::new()).append_pair("boardId",&target.board_id).append_pair("cardId",&target.card_id).append_pair("returnPlugin",&target.plugin).append_pair("returnRequestId",&target.request_id).append_pair("returnInvalid",if target.invalid{"1"}else{"0"}).finish()));
    if let Some(w)=app.get_webview_window("plugin-canvas"){
        if added{w.eval("location.reload()").map_err(|e|e.to_string())?;}
        if let Some(target)=&source {
            let value=json!(target);
            // Store a pending target before dispatch, so an in-flight page startup
            // can recover it when its React listener is not attached yet.
            w.eval(&format!("window.__flowhubCanvasReturn={value};window.dispatchEvent(new CustomEvent('flowhub:canvas-return',{{detail:{value}}}))")).map_err(|e|e.to_string())?;
        }
        w.show().map_err(|e|e.to_string())?;return w.set_focus().map_err(|e|e.to_string());
    }
    let w=WebviewWindowBuilder::new(app,"plugin-canvas",WebviewUrl::App(source_url.unwrap_or_else(||"plugin-canvas.html".into()).into())).title("FlowHub · 桌面组件").transparent(true).decorations(false).shadow(false).visible(false).inner_size(1040.,720.).min_inner_size(360.,200.).always_on_top(layout.pinned).build().map_err(|e|e.to_string())?;
    #[cfg(not(target_os="macos"))]
    if let Some(position)=layout.window_position {
        let monitors:Vec<_>=app.available_monitors().map_err(|e|e.to_string())?.iter().map(|m|(m.position().x,m.position().y,m.size().width,m.size().height)).collect();
        if position_is_visible(position,&monitors){w.set_position(tauri::PhysicalPosition::new(position.0,position.1)).map_err(|e|e.to_string())?;}
        else {w.center().map_err(|e|e.to_string())?;}
    }
    #[cfg(target_os="macos")]
    let moved_window=w.clone();
    let handle=app.clone();w.on_window_event(move|event|{
        let state=handle.state::<State>();
        match event {
            tauri::WindowEvent::Moved(_position)=>{
                #[cfg(target_os="macos")]
                capture_canvas_position(&moved_window);
                #[cfg(not(target_os="macos"))]
                {let _=state.remember_position((_position.x,_position.y));}
            }
            tauri::WindowEvent::CloseRequested{..}=>{let _=state.update(|layout|layout.desktop=false);}
            _=>{}
        }
    });
    #[cfg(target_os="macos")]
    show_canvas(&w,layout)?;
    #[cfg(not(target_os="macos"))]
    {w.show().map_err(|e|e.to_string())?;w.set_focus().map_err(|e|e.to_string())?;}
    Ok(())
}
pub fn restore(app:&tauri::AppHandle){let desktop=app.state::<State>().layout.lock().unwrap().desktop;if desktop{let handle=app.clone();let _=app.run_on_main_thread(move||{let _=open(&handle,"");});}}
#[tauri::command]
pub async fn plugin_canvas_api(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String,payload:Value)->Result<Value,String>{
    if action=="detailContext" {
        let state=app.state::<State>();
        let entry=state.details.lock().unwrap().get(window.label())?.clone();
        let id=&entry.request.plugin;
        let definition=app.state::<crate::plugin::runtime::Runtime>().widget(&id)?;
        let loaded=app.state::<crate::plugin::runtime::Runtime>().loaded_at(id).unwrap_or_default();
        return Ok(json!({"plugin":id,"url":format!("flowhub-plugin://{}/{}?v={}",id,definition.detail,loaded),"context":entry.context,"revision":entry.revision,"source":{"boardId":entry.request.board_id,"cardId":entry.request.card_id}}));
    }
    if action=="detailReturn" || action=="detailClose" {
        let state=app.state::<State>();
        let entry=state.details.lock().unwrap().get(window.label())?.clone();
        if action=="detailReturn" {
            let valid=detail::validate_source(&state.layout.lock().unwrap(),&entry.request.board_id,&entry.request.card_id,&entry.request.plugin).is_ok();
            if valid {state.return_to_source(&entry.request)?;}
            let target=state.details.lock().unwrap().return_target(&entry.request,!valid);
            open_with_source(&app,"",Some(target))?;
        }
        window.close().map_err(|e|e.to_string())?;
        return Ok(Value::Null);
    }
    if !["settings","plugin-canvas"].contains(&window.label()){return Err("画布来源无效".into());}
    if action=="cursor" {
        return canvas_cursor(&window).await;
    }
    let state=app.state::<State>();
    if action=="save"{
        if payload.get("boards").is_some(){let next:Layout=serde_json::from_value(payload).map_err(|e|e.to_string())?;state.save_from_canvas(next)?;}
        else {let presentation:Presentation=serde_json::from_value(payload).map_err(|e|e.to_string())?;state.save_presentation(presentation)?;}
        let pinned=state.layout.lock().unwrap().pinned;if let Some(w)=app.get_webview_window("plugin-canvas"){w.set_always_on_top(pinned).map_err(|e|e.to_string())?;}
    }
    else if action=="setViewOnly" {
        let enabled=payload["enabled"].as_bool().ok_or("交互模式无效")?;
        state.update(|layout|layout.view_only=enabled)?;
        for label in ["plugin-canvas","settings"] {
            if label!=window.label() {
                if let Some(w)=app.get_webview_window(label) {let _=w.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-view-only',{{detail:{enabled}}}))"));}
            }
        }
    }
    else if action=="setLayoutLocked" {
        let enabled=payload["enabled"].as_bool().ok_or("布局锁定模式无效")?;
        state.update(|layout|layout.layout_locked=enabled)?;
        for label in ["plugin-canvas","settings"] {
            if label!=window.label() {
                if let Some(w)=app.get_webview_window(label) {let _=w.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-layout-locked',{{detail:{enabled}}}))"));}
            }
        }
    }
    else if action=="settings" {if window.label()!="plugin-canvas" {return Err("仅可从桌面组件打开设置".into());}crate::open_canvas_settings(app.clone())?;}
    else if action=="detail" {
        if window.label()!="plugin-canvas" {return Err("仅可从桌面组件打开详情".into());}
        let request:detail::Request=serde_json::from_value(payload).map_err(|e|e.to_string())?;
        request.validate(&state.layout.lock().unwrap())?;
        let definition=app.state::<crate::plugin::runtime::Runtime>().widget(&request.plugin)?;
        if definition.detail.trim().is_empty(){return Err("插件不支持详情".into());}
        let snapshot=app.state::<crate::plugin::status::State>().snapshot(&request.plugin).unwrap_or(Value::Null);
        let reservation=state.details.lock().unwrap().reserve(request,snapshot);
        let (label,create)=match reservation {
            detail::Reservation::Create(label)=>(label,true),
            detail::Reservation::Existing(label,mut ready)=>{
                if !*ready.borrow_and_update(){ready.changed().await.map_err(|_|"详情创建失败")?;}
                (label,false)
            }
        };
        if create {
            let title=state.details.lock().unwrap().get(&label)?.request.title.clone();
            let result=WebviewWindowBuilder::new(&app,&label,WebviewUrl::App("plugin-detail.html".into())).title(format!("{title} · 详情")).inner_size(860.,650.).min_inner_size(520.,400.).build();
            match result {
                Ok(w)=>{
                    let handle=app.clone();let key=label.clone();
                    w.on_window_event(move|event|{if matches!(event,tauri::WindowEvent::Destroyed){handle.state::<State>().details.lock().unwrap().remove(&key);}});
                    state.details.lock().unwrap().complete(&label)?;
                }
                Err(e)=>{state.details.lock().unwrap().remove(&label);return Err(e.to_string());}
            }
        }
        // Serialize publication on the UI thread. Read the latest revision inside
        // that operation, so a delayed older caller cannot overwrite a newer title.
        let (tx,rx)=tokio::sync::oneshot::channel();
        let handle=app.clone();
        app.run_on_main_thread(move||{
            let result=(||->Result<(),String>{
                let state=handle.state::<State>();
                let entry=state.details.lock().unwrap().get(&label)?.clone();
                let w=handle.get_webview_window(&label).ok_or_else(||{
                    state.details.lock().unwrap().remove(&label);"详情窗口已关闭".to_string()
                })?;
                w.set_title(&format!("{} · 详情",entry.request.title)).map_err(|e|e.to_string())?;
                w.eval("window.dispatchEvent(new CustomEvent('flowhub:detail-context-changed'))").map_err(|e|e.to_string())?;
                w.show().map_err(|e|e.to_string())?;w.set_focus().map_err(|e|e.to_string())?;
                Ok(())
            })();
            let _=tx.send(result);
        }).map_err(|e|e.to_string())?;
        rx.await.map_err(|_|"详情窗口更新中断")??;
    }
    else if action=="open" {open(&app,"")?;}
    else if action=="fit" {let width=payload["width"].as_f64().filter(|v|v.is_finite()).ok_or("窗口宽度无效")?;let height=payload["height"].as_f64().filter(|v|v.is_finite()).ok_or("窗口高度无效")?;let monitor=window.current_monitor().map_err(|e|e.to_string())?;let (mw,mh)=monitor.map(|m|{let s=m.size().to_logical::<f64>(m.scale_factor());(s.width,s.height)}).unwrap_or((1600.,1000.));window.set_size(tauri::LogicalSize::new(width.clamp(360.,mw.max(360.)),height.clamp(200.,mh.max(200.)))).map_err(|e|e.to_string())?;}
    else if action=="drag" {window.start_dragging().map_err(|e|e.to_string())?;}
    else if action=="close" {window.close().map_err(|e|e.to_string())?;}
    else if action!="get" {return Err("未知画布操作".into());}
    let sources:Vec<_>=app.state::<crate::plugin::runtime::Runtime>().widget_plugins().into_iter().map(|(id,title)|json!({"lastLoadedAt":app.state::<crate::plugin::runtime::Runtime>().loaded_at(&id),"snapshot":app.state::<crate::plugin::status::State>().snapshot(&id),"widget":app.state::<crate::plugin::runtime::Runtime>().widget(&id).ok(),"id":id,"title":title})).collect();
    let return_target=if action=="get" && window.label()=="plugin-canvas" {state.return_target.lock().unwrap().take()}else{None};
    Ok(json!({"layout":state.layout.lock().unwrap().clone(),"sources":sources,"returnTarget":return_target}))
}
#[cfg(test)]mod tests{use super::*;#[test]fn layouts_validate_and_persist(){let root=std::env::temp_dir().join(format!("canvas-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&root).unwrap();let s=State::new(&root).unwrap();let mut l=Layout::default();l.boards[0].cards.push(Card{id:"a".into(),plugin:"example".into(),title:"CPU".into(),view:"overview".into(),size:"large".into(),row:None,width:None,height:None,break_before:false,x:None,y:None,metrics:None,config:Value::Null});l.boards[0].cards[0].width=Some(413);l.boards[0].cards[0].height=Some(257);s.save(l.clone()).unwrap();assert_eq!(State::new(&root).unwrap().layout.lock().unwrap().boards[0].cards[0].width,Some(413));let mut invalid=l.clone();invalid.boards[0].cards[0].width=Some(0);assert!(s.save(invalid).is_err());assert_eq!(State::new(&root).unwrap().layout.lock().unwrap().boards[0].cards[0].size,"large");l.boards.push(l.boards[0].clone());assert!(s.save(l).is_err());std::fs::remove_dir_all(root).unwrap();}}
#[cfg(test)]
#[test]
fn legacy_cards_and_plugin_defined_config_survive_roundtrip(){
    let old=json!({"boards":[{"id":"default","title":"已有布局","cards":[{"id":"card","plugin":"machines","title":"服务器","view":"machine","size":"small","row":"host-a","metrics":["cpu","rx"],"width":201,"height":139,"x":211,"y":0}]}],"active":"default","pinned":true});
    let mut layout:Layout=serde_json::from_value(old).unwrap();
    layout.validate().unwrap();
    let card=&mut layout.boards[0].cards[0];
    assert!(card.config.is_null());assert_eq!(card.row.as_deref(),Some("host-a"));
    card.config=json!({"customPluginField":{"nested":["arbitrary-metric"]}});
    layout.validate().unwrap();
    let restored:Layout=serde_json::from_value(json!(layout)).unwrap();
    let card=&restored.boards[0].cards[0];
    assert_eq!((card.width,card.height,card.x),(Some(201),Some(139),Some(211)));
    assert_eq!(card.config["customPluginField"]["nested"][0],"arbitrary-metric");
}
#[cfg(test)]
#[test]
fn view_only_defaults_off_and_survives_canvas_layout_saves(){
    let old=json!({"boards":[{"id":"default","title":"我的工作台","cards":[]}],"active":"default","pinned":false});
    let legacy:Layout=serde_json::from_value(old).unwrap();
    assert!(!legacy.view_only);
    let root=std::env::temp_dir().join(format!("canvas-view-only-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();
    let state=State::new(&root).unwrap();
    state.update(|layout|layout.view_only=true).unwrap();
    state.save_from_canvas(legacy).unwrap();
    let persisted=State::new(&root).unwrap();
    let saved=persisted.layout.lock().unwrap();
    assert!(saved.view_only);
    assert_eq!(serde_json::to_value(&*saved).unwrap()["viewOnly"],true);
    drop(saved);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
#[test]
fn window_position_survives_restart_and_stale_frontend_saves(){
    let root=std::env::temp_dir().join(format!("canvas-position-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();
    let state=State::new(&root).unwrap();
    state.update(|layout|{layout.desktop=true;layout.view_only=true;}).unwrap();
    state.remember_position((-600,180)).unwrap();
    let mut stale=Layout::default();stale.window_position=Some((0,0));
    state.save_from_canvas(stale).unwrap();
    let restarted=State::new(&root).unwrap();
    let saved=restarted.layout.lock().unwrap();
    assert_eq!(saved.window_position,Some((-600,180)));
    assert!(saved.desktop);assert!(saved.view_only);
    assert_eq!(serde_json::to_value(&*saved).unwrap()["windowPosition"],json!([-600,180]));
    drop(saved);std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
#[test]
fn window_position_accepts_negative_monitor_origins_but_rejects_disconnected_displays(){
    let monitors=[(-1920,0,1920,1080),(0,0,1920,1080)];
    assert!(position_is_visible((-600,180),&monitors));
    assert!(position_is_visible((200,100),&monitors));
    assert!(position_is_visible((1840,1000),&monitors));
    assert!(!position_is_visible((3600,200),&monitors));
    assert!(!position_is_visible((1850,100),&monitors));
    assert!(!position_is_visible((0,1040),&monitors));
    assert!(!position_is_visible((i32::MAX,i32::MAX),&monitors));
}

#[cfg(test)]
#[test]
fn appkit_positions_and_legacy_migration_handle_mixed_scale_screens(){
    // Actual arrangement: a 2x MacBook and a 1x display above it.
    let screens=[(0.,0.,1512.,982.,2.),(-202.,982.,1920.,1080.,1.)];
    let frames:Vec<_>=screens.iter().map(|&(x,y,w,h,_)|(x,y,w,h)).collect();
    assert_eq!(legacy_appkit_position((472,-920),982.,&screens),Some((472.,1902.)));
    assert_eq!(legacy_appkit_position((400,200),982.,&screens),Some((200.,882.)));
    assert!(appkit_position_is_visible((472.,1902.),&frames));
    assert!(!appkit_position_is_visible((472.,1902.),&frames[..1]));
    assert!(!appkit_position_is_visible((f64::NAN,1902.),&frames));
    assert_eq!(legacy_appkit_position((9000,9000),982.,&screens),None);
    let left=[(0.,0.,1512.,982.,2.),(-1920.,0.,1920.,1080.,1.)];
    assert_eq!(legacy_appkit_position((-600,182),982.,&left),Some((-600.,800.)));
}

#[cfg(test)]
#[test]
fn appkit_window_position_survives_restart_and_stale_frontend_saves(){
    let root=std::env::temp_dir().join(format!("canvas-appkit-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();
    let state=State::new(&root).unwrap();
    state.remember_appkit_position((472.5,1902.)).unwrap();
    let mut stale=Layout::default();stale.window_position_appkit=Some((0.,900.));
    state.save_from_canvas(stale).unwrap();
    let restarted=State::new(&root).unwrap();
    assert_eq!(restarted.layout.lock().unwrap().window_position_appkit,Some((472.5,1902.)));
    assert_eq!(serde_json::to_value(&*restarted.layout.lock().unwrap()).unwrap()["windowPositionAppKit"],json!([472.5,1902.]));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
#[test]
fn layout_lock_defaults_off_persists_and_preserves_native_modes(){
    let old=json!({"boards":[{"id":"default","title":"旧布局","cards":[]}],"active":"default","pinned":false});
    let legacy:Layout=serde_json::from_value(old).unwrap();
    assert!(!legacy.layout_locked);
    let root=std::env::temp_dir().join(format!("canvas-lock-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();
    let state=State::new(&root).unwrap();state.save(legacy.clone()).unwrap();
    state.update(|layout|{layout.layout_locked=true;layout.view_only=true;}).unwrap();
    state.save_from_canvas(legacy).unwrap();
    let restarted=State::new(&root).unwrap();
    assert!(restarted.layout.lock().unwrap().layout_locked);
    assert!(restarted.layout.lock().unwrap().view_only);
    assert_eq!(json!(&*restarted.layout.lock().unwrap())["layoutLocked"],true);
    let mut stale=restarted.layout.lock().unwrap().clone();
    state.update(|layout|{layout.layout_locked=false;layout.view_only=false;}).unwrap();
    stale.pinned=true;state.save_from_canvas(stale).unwrap();
    let saved=state.layout.lock().unwrap();
    assert!(!saved.layout_locked);assert!(!saved.view_only);assert!(saved.pinned);
    drop(saved);std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
#[test]
fn locked_layout_rejects_stale_board_edits_but_accepts_presentation_changes(){
    let root=std::env::temp_dir().join(format!("canvas-lock-saves-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();let state=State::new(&root).unwrap();
    assert!(state.prepare_open("machines").unwrap());
    state.update(|layout|{
        layout.boards.push(Board{id:"second".into(),title:"第二布局".into(),cards:vec![]});
        layout.layout_locked=true;
    }).unwrap();
    let original=state.layout.lock().unwrap().clone();
    let mut edits=vec![];
    let mut renamed=original.clone();renamed.boards[0].title="改名".into();edits.push(renamed);
    let mut resized=original.clone();resized.boards[0].cards[0].width=Some(400);edits.push(resized);
    let mut moved=original.clone();moved.boards[0].cards[0].x=Some(200);edits.push(moved);
    let mut configured=original.clone();configured.boards[0].cards[0].config=json!({"filter":"changed"});edits.push(configured);
    let mut removed=original.clone();removed.boards[0].cards.clear();edits.push(removed);
    let mut removed_board=original.clone();removed_board.boards.pop();edits.push(removed_board);
    for mut edited in edits {
        edited.layout_locked=false;
        assert!(state.save_from_canvas(edited).is_err());
        assert!(state.layout.lock().unwrap().boards==original.boards);
    }
    let partial:Presentation=serde_json::from_value(json!({"active":"second","pinned":true})).unwrap();
    state.save_presentation(partial).unwrap();
    let saved=state.layout.lock().unwrap();assert_eq!(saved.active,"second");assert!(saved.pinned);assert!(saved.layout_locked);
    // Presentation writes never normalize absent dimensions in legacy cards.
    assert_eq!(saved.boards[0].cards[0].width,None);drop(saved);
    assert!(serde_json::from_value::<Presentation>(json!({"active":"second","pinned":false,"layoutLocked":false})).is_err());
    assert!(state.save_presentation(Presentation{active:"missing".into(),pinned:false}).is_err());
    state.update(|layout|layout.layout_locked=false).unwrap();
    state.save_presentation(Presentation{active:"default".into(),pinned:false}).unwrap();
    assert!(!state.layout.lock().unwrap().layout_locked);
    assert!(State::new(&root).unwrap().layout.lock().unwrap().boards==original.boards);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
#[test]
fn opening_a_plugin_cannot_add_widgets_or_overwrite_modes_while_locked(){
    let root=std::env::temp_dir().join(format!("canvas-lock-open-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();let state=State::new(&root).unwrap();
    state.update(|layout|layout.layout_locked=true).unwrap();
    assert!(!state.prepare_open("machines").unwrap());
    let saved=state.layout.lock().unwrap();assert!(saved.layout_locked);assert!(saved.desktop);assert!(saved.boards[0].cards.is_empty());drop(saved);
    state.update(|layout|{layout.layout_locked=false;layout.view_only=true;}).unwrap();
    assert!(!state.prepare_open("machines").unwrap());
    assert!(state.layout.lock().unwrap().view_only);
    state.update(|layout|layout.view_only=false).unwrap();
    assert!(state.prepare_open("machines").unwrap());
    assert!(!state.prepare_open("machines").unwrap());
    assert_eq!(state.layout.lock().unwrap().boards[0].cards.len(),1);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
#[test]
fn detail_sources_validate_and_return_without_editing_locked_layouts(){
    let root=std::env::temp_dir().join(format!("canvas-detail-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
    std::fs::create_dir_all(&root).unwrap();let state=State::new(&root).unwrap();
    state.prepare_open("machines").unwrap();
    state.update(|layout|{
        layout.boards.push(Board{id:"other".into(),title:"其他布局".into(),cards:vec![]});
        layout.active="other".into();layout.layout_locked=true;layout.view_only=true;layout.pinned=true;
    }).unwrap();
    let original=state.layout.lock().unwrap().clone();
    let request:detail::Request=serde_json::from_value(json!({"plugin":"machines","boardId":"default","cardId":original.boards[0].cards[0].id,"config":{},"title":"服务器"})).unwrap();
    request.validate(&original).unwrap();
    let mut invalid=request.clone();invalid.plugin="other".into();assert!(invalid.validate(&original).is_err());
    invalid=request.clone();invalid.board_id="other".into();assert!(invalid.validate(&original).is_err());
    invalid=request.clone();invalid.card_id="missing".into();assert!(state.return_to_source(&invalid).is_err());
    assert_eq!(state.layout.lock().unwrap().active,"other");
    state.return_to_source(&request).unwrap();
    let saved=state.layout.lock().unwrap().clone();
    assert_eq!(saved.active,"default");assert!(saved.boards==original.boards);
    assert!(saved.layout_locked);assert!(saved.view_only);assert!(saved.pinned);
    assert_eq!(State::new(&root).unwrap().layout.lock().unwrap().active,"default");
    state.update(|layout|layout.boards[0].cards[0].plugin="replacement".into()).unwrap();
    assert!(state.return_to_source(&request).is_err());
    state.update(|layout|layout.boards[0].cards.clear()).unwrap();
    assert!(state.return_to_source(&request).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
