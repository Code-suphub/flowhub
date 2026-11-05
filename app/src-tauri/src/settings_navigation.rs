//! Launcher deep links only select host pages or enabled plugin workspaces.
pub(crate) fn valid_module(module: &str) -> bool {
    matches!(module, "core"|"appearance"|"data"|"updates"|"search"|"menubar"|"canvas"|"web"|"app"|"clipboard"|"memo"|"tools"|"extensions")
        || module.strip_prefix("plugin:").is_some_and(|id| !id.is_empty() && id.len()<=80 && id.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'-' || c==b'_'))
}
pub(crate) fn path(module: &str) -> String {
    let mut query=url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("module",module);
    format!("settings.html?{}",query.finish())
}
pub(crate) fn script(module: &str) -> String {
    let argument=serde_json::to_string(module).expect("string serialization");
    format!("(() => {{ let attempts=0; const run=() => {{ if(window.switchModule) {{ window.switchModule({argument}); }} else if(++attempts<200) {{ setTimeout(run,100); }} }}; run(); }})();")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn settings_targets_are_fixed_pages_or_safe_plugin_ids() {
        for module in ["core","appearance","search","extensions","plugin:resource-monitor"] {assert!(valid_module(module));}
        for module in ["","unknown","plugin:","plugin:../secret","plugin:a');alert(1)//","https://example.com"] {assert!(!valid_module(module));}
        assert!(!valid_module(&format!("plugin:{}","a".repeat(81))));
        assert_eq!(path("plugin:resource-monitor"),"settings.html?module=plugin%3Aresource-monitor");
        assert!(script("appearance").contains("window.switchModule(\"appearance\")"));
        assert!(script("appearance").contains("attempts<200"));
    }
}
