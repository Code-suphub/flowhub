//! Metadata-only organization. Never change clipboard contents or infer writers.
use crate::{AppState,storage::database};
use chrono::Utc;
use rusqlite::params;
use serde_json::{json,Value};
use tauri::{Emitter,Manager};

fn allowed(label:&str)->Result<(),String>{if matches!(label,"main"|"settings"){Ok(())}else{Err("仅主体窗口可管理剪贴板备注".into())}}
pub(super) fn sources(state:&AppState)->Result<Vec<Value>,String>{
    let policy=super::CleanupPolicy::from_config(&crate::storage::read_json(&state.paths().config_path).unwrap_or_default());
    let cutoff=(Utc::now()-chrono::Duration::days(policy.days)).to_rfc3339();
    let db=database(state)?;
    let mut statement=db.prepare("SELECT trim(COALESCE(source_name,'')) AS source, count(*) FROM clipboard_records WHERE (?1=0 OR pinned_at IS NOT NULL OR julianday(last_seen_at)>=julianday(?2)) GROUP BY source ORDER BY count(*) DESC, source LIMIT 200").map_err(|error|error.to_string())?;
    let rows=statement.query_map(params![policy.days,cutoff],|row|Ok(json!({"name":row.get::<_,String>(0)?,"count":row.get::<_,i64>(1)?}))).map_err(|error|error.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())
}
pub(super) fn set_note(state:&AppState,id:i64,note:&str,expected:&str)->Result<Value,String>{
    if id<=0 || note.chars().count()>500 || expected.chars().count()>500 || note.contains('\0'){return Err("备注无效，最多 500 个字符".into());}
    let note=note.trim();
    let changed=database(state)?.execute("UPDATE clipboard_records SET note=?1 WHERE id=?2 AND COALESCE(note,'')=?3",params![note,id,expected]).map_err(|error|error.to_string())?;
    if changed!=1{return Err("记录已删除或备注已变化，请重新打开后编辑".into());}
    Ok(json!({"ok":true,"note":note}))
}
#[tauri::command]
pub(crate) async fn clipboard_sources(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<Vec<Value>,String>{
    allowed(window.label())?;
    tauri::async_runtime::spawn_blocking(move||sources(&app.state::<AppState>())).await.map_err(|error|error.to_string())?
}
#[tauri::command]
pub(crate) async fn set_clipboard_note(window:tauri::WebviewWindow,app:tauri::AppHandle,id:i64,note:String,expected_note:String)->Result<Value,String>{
    allowed(window.label())?;
    let worker=app.clone();
    let result=tauri::async_runtime::spawn_blocking(move||set_note(&worker.state::<AppState>(),id,&note,&expected_note)).await.map_err(|error|error.to_string())??;
    let _=app.emit("flowhub:clipboard-updated",json!({"reason":"note","id":id}));
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn organization_is_host_only(){assert!(allowed("main").is_ok());assert!(allowed("settings").is_ok());for label in ["plugin-panel","plugin-dock","widget-x",""]{assert!(allowed(label).is_err());}}
}
