use serde_json::Value;
#[cfg(target_os = "macos")]
#[path = "admin_monitor.rs"]
mod macos;

pub(crate) async fn invoke(action: &str) -> Result<Value, String> {
    if !matches!(action, "status" | "enable" | "disable") {
        return Err("不支持的系统进程授权操作".into());
    }
    #[cfg(not(target_os = "macos"))]
    return Err("系统级进程授权只支持 macOS。".into());

    #[cfg(target_os = "macos")]
    {
        let action = action.to_owned();
        tauri::async_runtime::spawn_blocking(move || macos::invoke(&action))
            .await
            .map_err(|error| format!("系统进程授权任务失败：{error}"))?
    }
}
