//! AppKit owns movement of the Settings -> dock -> panel window group.
//! Geometry is in logical AppKit points, never mixed-DPI physical coordinates.
use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{Manager, WebviewWindow};

fn on_main(app:&tauri::AppHandle, work:impl FnOnce(&tauri::AppHandle)->Result<(),String>+Send+'static)->Result<(),String> {
    if MainThreadMarker::new().is_some() {return work(app);}
    let handle=app.clone();let (tx,rx)=std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move||{let _=tx.send(work(&handle));}).map_err(|e|e.to_string())?;
    rx.recv().map_err(|_|"插件窗口操作中断".to_string())?
}

fn native(window:&WebviewWindow)->Result<&NSWindow,String> {
    MainThreadMarker::new().ok_or("插件窗口只能在主线程操作")?;
    let pointer=window.ns_window().map_err(|e|e.to_string())?;
    // The WebviewWindow holds its native window for this synchronous main-thread call.
    unsafe {pointer.cast::<NSWindow>().as_ref()}.ok_or("插件原生窗口已关闭".into())
}

fn attach(parent:&NSWindow,child:&NSWindow)->Result<(),String> {
    if std::ptr::eq(parent,child) {return Err("插件窗口不能绑定到自身".into());}
    if let Some(previous)=child.parentWindow() {
        if std::ptr::eq(&*previous,parent) {return Ok(());}
        previous.removeChildWindow(child);
    }
    // The only relationships created here are Settings -> dock and dock -> panel.
    unsafe {parent.addChildWindow_ordered(child,NSWindowOrderingMode::Above);}
    if !child.parentWindow().is_some_and(|actual|std::ptr::eq(&*actual,parent)) {
        return Err("插件窗口跟随绑定失败".into());
    }
    Ok(())
}

fn detach_window(window:&NSWindow) {
    if let Some(parent)=window.parentWindow() {parent.removeChildWindow(window);}
}

fn dock_origin(parent:NSRect,size:NSSize)->NSPoint {
    NSPoint::new(parent.origin.x+(parent.size.width-size.width)/2.,parent.origin.y-12.-size.height)
}

fn follow_now(app:&tauri::AppHandle)->Result<(),String> {
    let Some(dock)=app.get_webview_window(super::DOCK) else {return Ok(());};
    let dock=native(&dock)?;
    if !dock.isVisible() {return Ok(());}
    let Some(settings)=app.get_webview_window("settings") else {detach_window(dock);return Ok(());};
    let settings=native(&settings)?;
    if !settings.isVisible()||settings.isMiniaturized() {return Ok(());}
    let origin=dock_origin(settings.frame(),dock.frame().size);
    if dock.frame().origin!=origin {dock.setFrameOrigin(origin);}
    attach(settings,dock)?;
    if super::snapshot(app).open {anchor_now(app)?;}
    Ok(())
}

fn panel_frame(dock:NSRect,available:Option<NSRect>)->NSRect {
    let origin_y=dock.origin.y+dock.size.height+12.;
    let (width,height)=available.map(|screen| {
        let width=800_f64.min((screen.size.width-24.).max(1.));
        let height=560_f64.min((screen.size.height-24.).max(1.));
        // Limit the initial size when there is space above, without moving the group.
        let above=screen.origin.y+screen.size.height-12.-origin_y;
        (width,if above>0. {height.min(above)}else{height})
    }).unwrap_or((800.,560.));
    NSRect::new(NSPoint::new(dock.origin.x+(dock.size.width-width)/2.,origin_y),NSSize::new(width,height))
}

fn anchor_now(app:&tauri::AppHandle)->Result<(),String> {
    let Some(dock)=app.get_webview_window(super::DOCK) else {return Ok(());};
    let Some(panel)=app.get_webview_window(super::PANEL) else {return Ok(());};
    let dock=native(&dock)?;let panel=native(&panel)?;
    let frame=panel_frame(dock.frame(),dock.screen().map(|screen|screen.visibleFrame()));
    if panel.frame()!=frame {panel.setFrame_display(frame,true);}
    attach(dock,panel)
}

pub(super) fn follow(app:&tauri::AppHandle)->Result<(),String> {on_main(app,follow_now)}
pub(super) fn anchor(app:&tauri::AppHandle)->Result<(),String> {on_main(app,anchor_now)}
pub(super) fn detach(app:&tauri::AppHandle,label:&'static str)->Result<(),String> {
    on_main(app,move|app| {
        if let Some(window)=app.get_webview_window(label) {detach_window(native(&window)?);}
        Ok(())
    })
}
pub(super) fn resize(app:&tauri::AppHandle,width:f64)->Result<(),String> {
    on_main(app,move|app| {
        if let Some(window)=app.get_webview_window(super::DOCK) {
            let window=native(&window)?;let old=window.frame();
            let frame=NSRect::new(NSPoint::new(old.origin.x+(old.size.width-width)/2.,old.origin.y),NSSize::new(width,60.));
            if old!=frame {window.setFrame_display(frame,true);}
        }
        follow_now(app)?;
        if super::snapshot(app).open {anchor_now(app)?;}
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dock_keeps_its_gap_and_offset_outside_any_screen() {
        let size=NSSize::new(548.,60.);
        for (x,y) in [(266.,148.),(266.,-600.),(-4000.,2000.)] {
            let origin=dock_origin(NSRect::new(NSPoint::new(x,y),NSSize::new(980.,720.)),size);
            assert_eq!(origin,NSPoint::new(x+216.,y-72.));
        }
    }
    #[test]
    fn window_group_geometry_is_translation_invariant() {
        let parent=NSRect::new(NSPoint::new(-202.,-500.),NSSize::new(980.,720.));
        let size=NSSize::new(548.,60.);let before=dock_origin(parent,size);
        let delta=NSPoint::new(360.,-800.);
        let after=dock_origin(NSRect::new(NSPoint::new(parent.origin.x+delta.x,parent.origin.y+delta.y),parent.size),size);
        assert_eq!(after,NSPoint::new(before.x+delta.x,before.y+delta.y));
        let dock=NSRect::new(before,size);let panel=panel_frame(dock,None);
        let moved=panel_frame(NSRect::new(after,size),None);
        assert_eq!(moved.origin,NSPoint::new(panel.origin.x+delta.x,panel.origin.y+delta.y));
        assert_eq!(moved.size,panel.size);
    }
}
