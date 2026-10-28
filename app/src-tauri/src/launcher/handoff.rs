//! Hide the launcher on the UI thread before activating another application.
use tauri::Manager;

async fn on_main<T:Send+'static>(app:&tauri::AppHandle,work:impl FnOnce(&tauri::AppHandle)->Result<T,String>+Send+'static)->Result<T,String> {
    let handle=app.clone();let (tx,rx)=tokio::sync::oneshot::channel();
    app.run_on_main_thread(move||{let _=tx.send(work(&handle));}).map_err(|e|e.to_string())?;
    rx.await.map_err(|_|"启动器窗口操作中断".to_string())?
}

pub(crate) async fn begin(app:&tauri::AppHandle)->Result<Option<u64>,String> {
    on_main(app,|app| {
        let Some(window)=app.get_webview_window("main") else {return Ok(None);};
        if !window.is_visible().map_err(|e|e.to_string())? {return Ok(None);}
        let ticket=crate::MAIN_VISIBILITY.lock().unwrap().begin_launch();
        // Await this main-thread operation before spawning browser automation.
        window.hide().map_err(|e|e.to_string())?;
        crate::diagnostics::focus::record("activation-hide",serde_json::json!({}));
        Ok(Some(ticket))
    }).await
}

pub(crate) async fn recover(app:&tauri::AppHandle,ticket:Option<u64>)->Result<(),String> {
    let Some(ticket)=ticket else {return Ok(());};
    on_main(app,move|app| {
        let Some(window)=app.get_webview_window("main") else {return Ok(());};
        if !crate::MAIN_VISIBILITY.lock().unwrap().resume_launch(ticket,std::time::Instant::now()) {return Ok(());}
        #[cfg(target_os="macos")]
        {
            use tauri_nspanel::ManagerExt;
            let panel=app.get_webview_panel("main").map_err(|e|format!("恢复启动器失败：{e:?}"))?;
            panel.show_and_make_key();
        }
        #[cfg(not(target_os="macos"))]
        {
            window.show().map_err(|e|e.to_string())?;
            window.set_focus().map_err(|e|e.to_string())?;
        }
        // Keep the failed query and selection so its error is visible and retryable.
        window.eval("window.focusSearch?.();").map_err(|e|e.to_string())?;
        Ok(())
    }).await
}
