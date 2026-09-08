// Uses Tauri's actual production asset generator without starting an app.
#[test]
fn bundled_desktop_security() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let security = serde_json::to_value(&context.config().app.security).unwrap();
    let csp = security["csp"].as_str().unwrap();
    assert!(csp.contains("script-src 'self';"));
    assert!(csp.contains("object-src 'none'"));
    assert!(csp.contains("ipc: http://ipc.localhost https://ipc.localhost"));
    assert!(!csp.contains("ws:"));
    assert!(!csp.contains("unsafe-eval"));
    assert_eq!(
        security["dangerousDisableAssetCspModification"],
        serde_json::json!(["style-src"])
    );
    assert!(security["devCsp"]
        .as_str()
        .unwrap()
        .contains("ws://127.0.0.1:5174"));
    for page in ["/settings.html", "/search.html"] {
        let asset = context
            .assets()
            .get(&page.into())
            .expect("production page embedded");
        let html = String::from_utf8_lossy(&asset);
        // A nonce/hash on style-src disables unsafe-inline, breaking dynamic
        // style attributes used by virtual rows and tree indentation.
        assert!(!html.contains("<style nonce="));
        assert!(html.contains("tauri-adapter.js"));
        assert!(!html.contains("fixture.js"));
    }
}
