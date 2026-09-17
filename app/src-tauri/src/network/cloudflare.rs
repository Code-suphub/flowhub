//! Arbitrary-domain probing stays outside the WebView's connect-src policy.
use serde_json::{json, Value};
use std::time::Duration;

fn target(hostname: &str) -> Result<reqwest::Url, String> {
    let host = hostname.trim().to_ascii_lowercase();
    if host.len() > 253
        || !host.contains('.')
        || host.ends_with(".local")
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').any(|part| {
            part.is_empty()
                || part.len() > 63
                || part.starts_with('-')
                || part.ends_with('-')
                || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return Err("请输入有效域名，不含端口或路径".into());
    }
    reqwest::Url::parse(&format!("https://{host}/")).map_err(|_| "域名格式无效".into())
}

fn report(status: u16, headers: &reqwest::header::HeaderMap) -> Value {
    let mut evidence = Vec::new();
    if headers
        .get("server")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("cloudflare"))
    {
        evidence.push("server: cloudflare".to_string());
    }
    for name in ["cf-ray", "cf-cache-status", "cf-mitigated"] {
        if headers.contains_key(name) {
            evidence.push(name.to_string());
        }
    }
    let cloudflare = !evidence.is_empty();
    json!({"status": status, "cloudflare": cloudflare,
        "challenge": headers.contains_key("cf-mitigated") || (cloudflare && [403,429].contains(&status)),
        "evidence": evidence})
}

#[tauri::command]
pub async fn inspect_cloudflare(hostname: String) -> Result<Value, String> {
    let url = target(&hostname)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    // Only headers are consumed; drop the body without buffering it.
    let response = client
        .get(url)
        .header("accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|_| "域名检测请求失败".to_string())?;
    Ok(report(response.status().as_u16(), response.headers()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_host_without_network_or_shell() {
        for host in [
            "",
            "localhost",
            "foo.local",
            "127.0.0.1",
            "::1",
            "user@host.com",
            "a.com/path",
            "a.com:443",
            "-a.com",
            "a..com",
            "a.com?x",
        ] {
            assert!(target(host).is_err(), "{host}");
        }
        assert_eq!(
            target(" Example.COM ").unwrap().as_str(),
            "https://example.com/"
        );
    }
    #[test]
    fn headers_are_evidence_not_a_guarantee() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(report(200, &headers)["cloudflare"], false);
        headers.insert("cf-ray", "fake-or-real".parse().unwrap());
        assert_eq!(report(403, &headers)["challenge"], true);
        assert_eq!(report(200, &headers)["challenge"], false);
    }
}
