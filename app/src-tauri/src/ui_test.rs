//! Explicit test-only entry point. Never runs the normal launcher bootstrap.
use std::path::PathBuf;
use serde::Deserialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use std::{io::Write, sync::{Mutex,atomic::{AtomicU64,Ordering}}, time::Instant};

struct Audit(Mutex<std::fs::File>);
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
fn record(app:&tauri::AppHandle, method:&str, action:&str, phase:&str, id:u64, elapsed:u128, success:Option<bool>) {
    let line=serde_json::json!({"at":chrono::Utc::now().to_rfc3339(),"pid":std::process::id(),"id":id,"method":method,"action":action,"phase":phase,"elapsedMs":elapsed,"success":success});
    if let Ok(mut file)=app.state::<Audit>().0.lock(){let _=writeln!(file,"{line}");}
}
fn begin(app:&tauri::AppHandle,method:&str,action:&str)->(u64,Instant){
    let id=SEQUENCE.fetch_add(1,Ordering::Relaxed);record(app,method,action,"start",id,0,None);(id,Instant::now())
}
#[tauri::command]
async fn plugin_rpc(window:tauri::WebviewWindow,app:tauri::AppHandle,id:String,method:String,params:serde_json::Value)->Result<serde_json::Value,String>{
    let action=params["action"].as_str().unwrap_or("").to_owned();let (ticket,started)=begin(&app,&method,&action);
    let result=crate::plugin::runtime::plugin_rpc(window,app.clone(),id,method.clone(),params).await;
    record(&app,&method,&action,"finish",ticket,started.elapsed().as_millis(),Some(result.is_ok()));result
}
#[tauri::command]
async fn plugin_api(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String,payload:serde_json::Value)->Result<serde_json::Value,String>{
    let (ticket,started)=begin(&app,"plugin_api",&action);
    let result=crate::plugin::runtime::plugin_api(window,app.clone(),action.clone(),payload).await;
    record(&app,"plugin_api",&action,"finish",ticket,started.elapsed().as_millis(),Some(result.is_ok()));result
}
#[tauri::command]
async fn plugin_workspace(window:tauri::WebviewWindow,app:tauri::AppHandle,action:String,module:Option<String>,width:Option<f64>)->Result<crate::plugin_workspace::Snapshot,String>{
    let (ticket,started)=begin(&app,"plugin_workspace",&action);
    let result=crate::plugin_workspace::plugin_workspace(window,app.clone(),action.clone(),module,width).await;
    record(&app,"plugin_workspace",&action,"finish",ticket,started.elapsed().as_millis(),Some(result.is_ok()));result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    root: PathBuf,
    token: String,
    port: u16,
    module: String,
    package: Option<PathBuf>,
}

fn validate(config: &Config) -> Result<PathBuf, String> {
    let root = config.root.canonicalize().map_err(|e| e.to_string())?;
    let home = dirs::home_dir().ok_or("缺少用户目录")?;
    let production=home.join("Library/Application Support/FlowHub");
    let actual_production=production.canonicalize().unwrap_or_else(|_|production.clone());
    if root == home || root.starts_with(production) || root.starts_with(actual_production) {
        return Err("测试实例不能使用正式数据目录".into());
    }
    if config.token.len() < 32 || config.port == 0 || std::fs::read_to_string(root.join(".flowhub-ui-test")).ok().as_deref() != Some(&config.token) {
        return Err("测试目录缺少匹配的实例标记".into());
    }
    // The machines plugin's fresh-install bootstrap otherwise discovers the
    // user's real shared SSH file. Require an explicit, local-only fixture.
    if config.module == "plugin:machines" {
        let state: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("machines/state.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let profile = state["sharedConfigFile"].as_str().ok_or("需要隔离 SSH 配置")?;
        let profile = PathBuf::from(profile).canonicalize().map_err(|e| e.to_string())?;
        if !profile.starts_with(&root) || state["monitoring"] != false { return Err("测试 SSH 配置必须在隔离目录内且关闭监控".into()); }
        let profiles: serde_json::Value = serde_json::from_slice(&std::fs::read(profile).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let rows = profiles.as_array().ok_or("测试连接配置必须为数组")?;
        if rows.is_empty() || rows.iter().any(|p| {
            let key=p["privateKey"].as_str().and_then(|key|PathBuf::from(key).canonicalize().ok());
            p["host"] != "127.0.0.1" || p.get("type").is_some_and(|t|!t.is_null())
                || p["password"].as_str().is_some_and(|password|!password.is_empty())
                || !key.is_some_and(|key|key.starts_with(&root))
                || p["proxyJump"].as_str().is_some_and(|jump|!jump.is_empty() && jump!="none")
        }) {
            return Err("机器验收仅允许回环地址的密钥测试连接".into());
        }
    }
    Ok(root)
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::args_os().nth(1).ok_or("需要测试配置文件路径")?;
    let config: Config = serde_json::from_slice(&std::fs::read(file)?)?;
    let root = validate(&config)?;
    let runtime = crate::plugin::runtime::Runtime::new(root.clone())?;
    let mut audit_options=std::fs::OpenOptions::new();audit_options.create(true).append(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; audit_options.mode(0o600); }
    let audit=Audit(Mutex::new(audit_options.open(root.join("ui-test-rpc.jsonl"))?));
    if let Some(package) = config.package { runtime.install_ui_test_fixture(package)?; }
    let workspace = crate::plugin_workspace::Workspace::ui_test(config.module)?;
    let script = include_str!("../../scripts/dev/ui-test-agent.js")
        .replace("__FLOWHUB_UI_TEST_TOKEN__", &serde_json::to_string(&config.token)?)
        .replace("__FLOWHUB_UI_TEST_PID__", &std::process::id().to_string());
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "cn.ac.camellia.flowhub.ui-test".into();
    context.config_mut().product_name = Some("FlowHub UI Test".into());
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(runtime)
        .manage(audit)
        .manage(workspace)
        .plugin(tauri_plugin_wdio_webdriver::init_with_port(config.port))
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("flowhub-plugin", |context, request| {
            let uri = request.uri(); let id = uri.host().unwrap_or("");
            let result = context.app_handle().state::<crate::plugin::runtime::Runtime>().asset(id, uri.path().trim_start_matches('/'));
            let (status, body, mime) = match result { Ok((body,mime)) => (200,body,mime), Err(error) => (404,error.into_bytes(),"text/plain") };
            tauri::http::Response::builder().status(status).header("Content-Type",mime)
                .header("Content-Security-Policy",crate::plugin::runtime::asset_csp(id)).body(body).unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            plugin_api, plugin_rpc, plugin_workspace
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app,"plugin-panel",WebviewUrl::App("plugin-workspace.html?view=panel".into()))
                .title("FlowHub UI Test · 独立验收")
                .inner_size(800.0,560.0).focused(false).focusable(false).incognito(true)
                .initialization_script_for_all_frames(script)
                .build()?;
            Ok(())
        })
        .run(context)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_fixture_rejects_missing_marker_and_real_ssh_targets() {
        let root = std::env::temp_dir().join(format!("fh-ui-guard-{}",std::process::id()));
        std::fs::create_dir_all(root.join("machines")).unwrap();
        let mut config = Config { root:root.clone(), token:"a".repeat(64), port:4455, module:"extensions".into(), package:None };
        assert!(validate(&config).unwrap_err().contains("标记"));
        std::fs::write(root.join(".flowhub-ui-test"),&config.token).unwrap();
        assert!(validate(&config).is_ok());
        config.module = "plugin:machines".into();
        let profiles = root.join("profiles.json");
        std::fs::write(root.join("machines/state.json"),serde_json::json!({"sharedConfigFile":profiles,"monitoring":false}).to_string()).unwrap();
        std::fs::write(&profiles,r#"[{"host":"real.example"}]"#).unwrap();
        assert!(validate(&config).unwrap_err().contains("回环"));
        std::fs::write(root.join("fixture-key"),"test-only-placeholder").unwrap();
        std::fs::write(&profiles,serde_json::json!([{"host":"127.0.0.1","privateKey":root.join("fixture-key"),"password":""}]).to_string()).unwrap();
        assert!(validate(&config).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
}
