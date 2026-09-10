use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[tauri::command]
pub async fn plugin_metric_history(window:tauri::WebviewWindow,app:tauri::AppHandle,plugin:String,row:String,metric:String,seconds:u64)->Result<Value,String>{
    if !window.label().starts_with("widget-detail-"){return Err("详情来源无效".into());}
    if row.len()>128||!["cpu","memory","disk","load","rx","tx","uptime"].contains(&metric.as_str())||![3600,86400,604800,2592000,7776000].contains(&seconds){return Err("查询参数无效".into());}
    app.state::<crate::plugin_runtime::Runtime>().status_history(&plugin,json!({"row":row,"metric":metric,"seconds":seconds})).await
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Card { id:String, plugin:String, title:String, view:String, size:String, #[serde(default)] row:Option<String>, #[serde(default)] width:Option<u32>, #[serde(default)] height:Option<u32>, #[serde(default)] break_before:bool, #[serde(default)] x:Option<u32>, #[serde(default)] y:Option<u32>, #[serde(default)] metrics:Option<Vec<String>> }
#[derive(Clone, Serialize, Deserialize)]
pub struct Board { id:String, title:String, cards:Vec<Card> }
#[derive(Clone, Serialize, Deserialize)]
pub struct Layout { boards:Vec<Board>, active:String, pinned:bool, #[serde(default)] desktop:bool, #[serde(default)] version:u32 }
impl Default for Layout {fn default()->Self{Self{boards:vec![Board{id:"default".into(),title:"我的工作台".into(),cards:vec![]}],active:"default".into(),pinned:false,desktop:false,version:2}}}
impl Layout {
    fn validate(&self)->Result<(),String>{
        if self.boards.is_empty() || self.boards.len()>12 || !self.boards.iter().any(|b|b.id==self.active){return Err("画布数量或当前画布无效".into());}
        let mut ids=std::collections::HashSet::new();
        for b in &self.boards {
            if b.id.is_empty()||b.id.len()>80||!ids.insert(&b.id)||b.title.trim().is_empty()||b.title.len()>120||b.cards.len()>32{return Err("画布配置无效".into());}
            let mut cards=std::collections::HashSet::new();
            for c in &b.cards { if c.metrics.as_ref().is_some_and(|m|m.is_empty()||m.len()>7||m.iter().any(|v|!["cpu","memory","disk","rx","tx","load","uptime"].contains(&v.as_str()))){return Err("显示指标无效".into());} if c.x.is_some_and(|v|v>52000)||c.y.is_some_and(|v|v>52000){return Err("组件位置超出范围".into());} if c.width.is_some_and(|v| !(160..=1600).contains(&v)) || c.height.is_some_and(|v| !(120..=1200).contains(&v)) { return Err("组件尺寸超出范围".into()); } }
            for c in &b.cards{if c.id.is_empty()||c.id.len()>80||!cards.insert(&c.id)||c.plugin.is_empty()||c.plugin.len()>128||c.title.len()>120||c.row.as_ref().is_some_and(|r|r.len()>128)||!["machine","overview","list","alerts"].contains(&c.view.as_str())||!["small","medium","large"].contains(&c.size.as_str()){return Err("组件配置无效".into());}}
        } Ok(())
    }
}
pub struct State { path:PathBuf, layout:Mutex<Layout> }
impl State {
    pub fn new(root:&std::path::Path)->Result<Self,String>{let path=root.join("plugin-canvas.json");let layout=match std::fs::read(&path){Ok(b)=>serde_json::from_slice::<Layout>(&b).map_err(|e|e.to_string())?,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Layout::default(),Err(e)=>return Err(e.to_string())};layout.validate()?;Ok(Self{path,layout:Mutex::new(layout)})}
    fn save(&self, next:Layout)->Result<(),String>{next.validate()?;let mut layout=self.layout.lock().unwrap();crate::storage::write_json_atomic(&self.path,&json!(next))?;*layout=next;Ok(())}
}
pub fn open(app:&tauri::AppHandle,plugin:&str)->Result<(),String>{
    let state=app.state::<State>();let mut layout=state.layout.lock().unwrap().clone();let mut added=false;
    if !plugin.is_empty() && !layout.boards.iter().any(|b|b.cards.iter().any(|c|c.plugin==plugin)) {
        let board=layout.boards.iter_mut().find(|b|b.id==layout.active).unwrap();
        if board.cards.len()<32{board.cards.push(Card{id:format!("widget-{}",chrono::Utc::now().timestamp_millis()),plugin:plugin.into(),title:String::new(),view:"overview".into(),size:"small".into(),row:None,width:None,height:None,break_before:false,x:None,y:None,metrics:None});state.save(layout.clone())?;added=true;}
    }
    layout.desktop=true;state.save(layout.clone())?;
    if let Some(w)=app.get_webview_window("plugin-canvas"){if added{w.eval("location.reload()").map_err(|e|e.to_string())?;}w.show().map_err(|e|e.to_string())?;return w.set_focus().map_err(|e|e.to_string());}
    let w=WebviewWindowBuilder::new(app,"plugin-canvas",WebviewUrl::App("plugin-canvas.html".into())).title("FlowHub · 桌面组件").transparent(true).decorations(false).shadow(false).inner_size(1040.,720.).min_inner_size(360.,200.).always_on_top(layout.pinned).build().map_err(|e|e.to_string())?;
    let handle=app.clone();w.on_window_event(move|event|{if let tauri::WindowEvent::CloseRequested{..}=event{let state=handle.state::<State>();let mut next=state.layout.lock().unwrap().clone();next.desktop=false;let _=state.save(next);}});
    Ok(())
}
pub fn restore(app:&tauri::AppHandle){let desktop=app.state::<State>().layout.lock().unwrap().desktop;if desktop{let handle=app.clone();let _=app.run_on_main_thread(move||{let _=open(&handle,"");});}}
#[tauri::command]
pub fn plugin_canvas_api(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String,payload:Value)->Result<Value,String>{
    if !["settings","plugin-canvas"].contains(&window.label()){return Err("画布来源无效".into());}
    if action=="cursor" {
        let cursor=window.cursor_position().map_err(|e|e.to_string())?;
        let origin=window.inner_position().map_err(|e|e.to_string())?;
        let scale=window.scale_factor().map_err(|e|e.to_string())?;
        return Ok(json!({"x":(cursor.x-origin.x as f64)/scale,"y":(cursor.y-origin.y as f64)/scale}));
    }
    let state=app.state::<State>();
    if action=="save"{let next:Layout=serde_json::from_value(payload).map_err(|e|e.to_string())?;state.save(next)?;let pinned=state.layout.lock().unwrap().pinned;if let Some(w)=app.get_webview_window("plugin-canvas"){w.set_always_on_top(pinned).map_err(|e|e.to_string())?;}}
    else if action=="detail" {
        let id=payload["plugin"].as_str().ok_or("缺少插件")?;let row=payload["row"].as_str().ok_or("请选择机器")?;
        if id.len()>128||row.len()>128||!app.state::<crate::plugin_runtime::Runtime>().status_plugins().iter().any(|(p,_)|p==id){return Err("详情来源无效".into());}
        let title=payload["title"].as_str().unwrap_or("机器详情");
        let query=url::form_urlencoded::Serializer::new(String::new()).append_pair("plugin",id).append_pair("row",row).append_pair("title",title).finish();
        WebviewWindowBuilder::new(&app,format!("widget-detail-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()),WebviewUrl::App(format!("widget-detail.html?{query}").into())).title(format!("{title} · 监控详情")).inner_size(860.,650.).min_inner_size(520.,400.).build().map_err(|e|e.to_string())?;
    }
    else if action=="open" {open(&app,"")?;}
    else if action=="fit" {let width=payload["width"].as_f64().filter(|v|v.is_finite()).ok_or("窗口宽度无效")?;let height=payload["height"].as_f64().filter(|v|v.is_finite()).ok_or("窗口高度无效")?;let monitor=window.current_monitor().map_err(|e|e.to_string())?;let (mw,mh)=monitor.map(|m|{let s=m.size().to_logical::<f64>(m.scale_factor());(s.width,s.height)}).unwrap_or((1600.,1000.));window.set_size(tauri::LogicalSize::new(width.clamp(360.,mw.max(360.)),height.clamp(200.,mh.max(200.)))).map_err(|e|e.to_string())?;}
    else if action=="drag" {window.start_dragging().map_err(|e|e.to_string())?;}
    else if action=="close" {window.close().map_err(|e|e.to_string())?;}
    else if action!="get" {return Err("未知画布操作".into());}
    let sources:Vec<_>=app.state::<crate::plugin_runtime::Runtime>().status_plugins().into_iter().map(|(id,title)|json!({"snapshot":app.state::<crate::plugin_status::State>().snapshot(&id),"id":id,"title":title})).collect();
    Ok(json!({"layout":state.layout.lock().unwrap().clone(),"sources":sources}))
}
#[cfg(test)]mod tests{use super::*;#[test]fn layouts_validate_and_persist(){let root=std::env::temp_dir().join(format!("canvas-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&root).unwrap();let s=State::new(&root).unwrap();let mut l=Layout::default();l.boards[0].cards.push(Card{id:"a".into(),plugin:"example".into(),title:"CPU".into(),view:"overview".into(),size:"large".into(),row:None,width:None,height:None,break_before:false,x:None,y:None,metrics:None});l.boards[0].cards[0].width=Some(413);l.boards[0].cards[0].height=Some(257);s.save(l.clone()).unwrap();assert_eq!(State::new(&root).unwrap().layout.lock().unwrap().boards[0].cards[0].width,Some(413));let mut invalid=l.clone();invalid.boards[0].cards[0].width=Some(0);assert!(s.save(invalid).is_err());assert_eq!(State::new(&root).unwrap().layout.lock().unwrap().boards[0].cards[0].size,"large");l.boards.push(l.boards[0].clone());assert!(s.save(l).is_err());std::fs::remove_dir_all(root).unwrap();}}
