//! Explicit local QA entry. Executes the production search pipeline in its WebKit window.
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::Manager;
const RUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
static RUNS: Mutex<Runs> = Mutex::new(Runs {
    generation: 0,
    active: None,
});

struct Run {
    id: u64,
    previous_pin: bool,
}
struct Runs {
    generation: u64,
    active: Option<Run>,
}
impl Runs {
    fn begin(&mut self, pin: &AtomicBool) -> Option<u64> {
        if self.active.is_some() {
            return None;
        }
        // Never reuse an ID, including at overflow.
        self.generation = self.generation.checked_add(1)?;
        self.active = Some(Run {
            id: self.generation,
            previous_pin: pin.swap(true, Ordering::AcqRel),
        });
        Some(self.generation)
    }

    fn complete<T>(
        &mut self,
        id: u64,
        pin: &AtomicBool,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.active.as_ref().is_some_and(|run| run.id == id) {
            return Err("No matching diagnostic run active".into());
        }
        // Serialize report writes with completion/start so late reports cannot
        // overwrite a subsequent run. Errors must restore pin as well.
        let result = action();
        let run = self.active.take().unwrap();
        pin.store(run.previous_pin, Ordering::Release);
        result
    }
}

fn finish(id: u64) {
    let _ = RUNS
        .lock()
        .unwrap()
        .complete(id, &crate::LAUNCHER_PINNED, || Ok(()));
}

async fn expire_after(runs: &Mutex<Runs>, pin: &AtomicBool, id: u64, timeout: Duration) {
    tokio::time::sleep(timeout).await;
    let _ = runs.lock().unwrap().complete(id, pin, || Ok(()));
}

fn runner_script(id: u64, source: &str) -> String {
    // A lexical facade scopes the token to this evaluation, even after timeout.
    // The runner's existing window.__TAURI__.core.invoke stays compatible;
    // neither the real window nor its invoke function is modified.
    format!(
        r#"(async () => {{
        const runId = "{id}";
        const native = globalThis.__TAURI__;
        const invoke = native.core.invoke;
        const scoped = {{...native, core: {{...native.core, invoke(command, args, options) {{
            return invoke(command, command === 'save_search_diagnostic_run' ? {{...args, runId}} : args, options);
        }}}}}};
        const window = new Proxy(globalThis, {{get(target, key) {{
            return key === '__TAURI__' ? scoped : Reflect.get(target, key, target);
        }}}});
        try {{ await {source}
        }} finally {{
            await invoke('save_search_diagnostic_run', {{runId}}).catch(() => {{}});
        }}
    }})().catch(() => {{}});"#
    )
}

pub fn start(app: &tauri::AppHandle) {
    let Some(id) = RUNS.lock().unwrap().begin(&crate::LAUNCHER_PINNED) else {
        return;
    };
    // Arm before window work. Successful eval only means script submission.
    tauri::async_runtime::spawn(expire_after(
        &RUNS,
        &crate::LAUNCHER_PINNED,
        id,
        RUN_TIMEOUT,
    ));
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        crate::show_macos_window(&window);
        #[cfg(not(target_os = "macos"))]
        if window.show().is_err() {
            finish(id);
            return;
        }
        if window
            .eval(&runner_script(
                id,
                include_str!("../../../scripts/stress/native-run.js"),
            ))
            .is_ok()
        {
            return;
        }
    }
    finish(id);
}
#[tauri::command]
pub fn save_search_diagnostic_run(
    app: tauri::AppHandle,
    run_id: String,
    report: Option<Value>,
) -> Result<(), String> {
    let id = run_id
        .parse::<u64>()
        .map_err(|_| "Invalid diagnostic run ID".to_string())?;
    RUNS.lock()
        .unwrap()
        .complete(id, &crate::LAUNCHER_PINNED, || {
            // Wrapper cleanup without a report preserves the last successful report.
            let Some(report) = report else {
                return Ok(());
            };
            let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
            if bytes.len() > 256 * 1024 {
                return Err("Diagnostic report too large".into());
            }
            let path = app
                .state::<crate::AppState>()
                .storage_dir()
                .join("diagnostics");
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            std::fs::write(path.join("search-native-latest.json"), bytes).map_err(|e| e.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    fn injected_wrapper_cleans_up_rejections_and_keeps_tokens_local() {
        let rejected = runner_script(1, "Promise.reject(new Error('startup failed'));");
        let delayed = runner_script(2, "(async () => { await globalThis.gate; await window.__TAURI__.core.invoke('save_search_diagnostic_run', {report: {ok: true}}); })();");
        let success = runner_script(
            3,
            "window.__TAURI__.core.invoke('save_search_diagnostic_run', {report: {ok: true}});",
        );
        // Execute the actual generated JS with mocked IPC, never a real app or
        // user data. Node is already a required host UI build dependency.
        let program = format!(
            r#"
            const assert = require('node:assert/strict'), vm = require('node:vm');
            (async () => {{
                const calls = [];
                const invoke = async (command, args) => calls.push({{command, ...args}});
                let release;
                const context = vm.createContext({{__TAURI__: {{core: {{invoke}}}}, gate: new Promise(r => release = r)}});
                await vm.runInContext({rejected}, context);
                assert.equal(calls.length, 1);
                assert.equal(calls[0].runId, '1');
                assert.equal(calls[0].report, undefined);
                const old = vm.runInContext({delayed}, context);
                await vm.runInContext({success}, context);
                release(); await old;
                assert.deepEqual(calls.map(c => c.runId), ['1', '3', '3', '2', '2']);
                assert.equal(calls[1].report.ok, true);
                assert.equal(calls[3].report.ok, true);
                assert.equal(context.__TAURI__.core.invoke, invoke);
            }})().catch(error => {{console.error(error); process.exitCode = 1;}});
        "#,
            rejected = serde_json::to_string(&rejected).unwrap(),
            delayed = serde_json::to_string(&delayed).unwrap(),
            success = serde_json::to_string(&success).unwrap(),
        );
        let mut child = Command::new("node")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node is required for host UI tests");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(program.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn runs() -> Mutex<Runs> {
        Mutex::new(Runs {
            generation: 0,
            active: None,
        })
    }

    #[test]
    fn startup_failure_and_report_error_restore_original_pin() {
        for original in [false, true] {
            for failed in [false, true] {
                let pin = AtomicBool::new(original);
                let runs = runs();
                let mut state = runs.lock().unwrap();
                let id = state.begin(&pin).unwrap();
                assert!(pin.load(Ordering::Acquire));
                assert!(state.begin(&pin).is_none());
                let result = state.complete(id, &pin, || {
                    if failed {
                        Err("write failed".into())
                    } else {
                        Ok(())
                    }
                });
                assert_eq!(result.is_err(), failed);
                assert_eq!(pin.load(Ordering::Acquire), original);
                assert!(state.active.is_none());
                assert!(state.begin(&pin).unwrap() > id);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_restores_pin_and_rejects_late_report() {
        for original in [false, true] {
            let runs = runs();
            let pin = AtomicBool::new(original);
            let first = runs.lock().unwrap().begin(&pin).unwrap();
            expire_after(&runs, &pin, first, RUN_TIMEOUT).await;
            assert_eq!(pin.load(Ordering::Acquire), original);
            let mut state = runs.lock().unwrap();
            let next = state.begin(&pin).unwrap();
            assert!(state
                .complete(first, &pin, || -> Result<(), String> {
                    panic!("stale report must not write")
                })
                .is_err());
            assert_eq!(state.active.as_ref().unwrap().id, next);
            assert!(pin.load(Ordering::Acquire));
            state.complete(next, &pin, || Ok(())).unwrap();
            assert_eq!(pin.load(Ordering::Acquire), original);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn old_watchdog_and_duplicate_completion_cannot_end_next_run() {
        let runs = runs();
        let pin = AtomicBool::new(false);
        let first = runs.lock().unwrap().begin(&pin).unwrap();
        runs.lock()
            .unwrap()
            .complete(first, &pin, || Ok(()))
            .unwrap();
        pin.store(true, Ordering::Release);
        let next = runs.lock().unwrap().begin(&pin).unwrap();
        expire_after(&runs, &pin, first, RUN_TIMEOUT).await;
        let mut state = runs.lock().unwrap();
        assert!(state.complete(first, &pin, || Ok(())).is_err());
        assert_eq!(state.active.as_ref().unwrap().id, next);
        assert!(pin.load(Ordering::Acquire));
        state.complete(next, &pin, || Ok(())).unwrap();
        assert!(pin.load(Ordering::Acquire));
    }

    #[test]
    fn generation_never_wraps() {
        let mut state = Runs {
            generation: u64::MAX,
            active: None,
        };
        let pin = AtomicBool::new(false);
        assert!(state.begin(&pin).is_none());
        assert!(!pin.load(Ordering::Acquire));
    }
}
