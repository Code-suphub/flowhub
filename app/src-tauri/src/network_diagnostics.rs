//! Bounded, argument-based network tools. Never invokes a shell.
use serde::Serialize;
use std::{io::Read, process::{Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
static RUNNING: Mutex<()> = Mutex::new(());
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Report { output:String, exit_code:Option<i32>, elapsed_ms:u128, timed_out:bool, truncated:bool }
fn arguments(kind:&str, target:&str, head:bool)->Result<(&'static str,Vec<String>),String> {
    if kind=="ping" {
        if target.is_empty() || target.len()>253 || target.starts_with('-') || !target.bytes().all(|c| c.is_ascii_alphanumeric() || b".-:".contains(&c)) {
            return Err("请输入域名、IPv4 或 IPv6 地址".into());
        }
        return Ok((if target.contains(':') {"/sbin/ping6"} else {"/sbin/ping"},vec!["-n".into(),"-c".into(),"4".into(),target.into()]));
    }
    if kind!="curl" { return Err("不支持的网络工具".into()); }
    let url=reqwest::Url::parse(target).map_err(|_| "请输入完整 http:// 或 https:// 地址")?;
    if target.len()>4096 || !matches!(url.scheme(),"http"|"https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("仅支持不含账号密码的 HTTP / HTTPS 地址".into());
    }
    let mut args=vec!["-q","--silent","--show-error","--include","--connect-timeout","3","--max-time","10","--max-filesize","65536","--proto","=http,https"].into_iter().map(String::from).collect::<Vec<_>>();
    if head {args.push("--head".into());}
    args.extend(["--url".into(),url.to_string()]);
    Ok(("/usr/bin/curl",args))
}
fn read_output(mut stream:impl Read)->(String,bool) {
    let mut saved=Vec::new(); let mut buffer=[0u8;4096]; let mut truncated=false;
    while let Ok(n)=stream.read(&mut buffer) {
        if n==0 {break;}
        let keep=n.min(32768usize.saturating_sub(saved.len()));
        saved.extend_from_slice(&buffer[..keep]); truncated |= keep<n;
    }
    (String::from_utf8_lossy(&saved).into_owned(),truncated)
}
fn run(kind:&str,target:&str,head:bool)->Result<Report,String> {
    let (path,args)=arguments(kind,target,head)?;
    if !cfg!(target_os="macos") {return Err("本机执行目前支持 macOS".into());}
    let _guard=RUNNING.try_lock().map_err(|_| "已有网络诊断正在运行，请稍后重试")?;
    let started=Instant::now();
    let mut child=Command::new(path).args(args).env("LC_ALL","C").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let out=child.stdout.take().unwrap(); let err=child.stderr.take().unwrap();
    let stdout=std::thread::spawn(move||read_output(out));let stderr=std::thread::spawn(move||read_output(err));
    let mut timed_out=false;
    let status=loop {
        match child.try_wait() {
            Ok(Some(status))=>break status,
            Ok(None)=>{},
            Err(error)=>{let _=child.kill();let _=child.wait();return Err(error.to_string());}
        }
        if started.elapsed()>Duration::from_secs(if kind=="ping" {8} else {12}) {
            timed_out=true;let _=child.kill();break child.wait().map_err(|e|e.to_string())?;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (out,a)=stdout.join().unwrap_or_default();let (err,b)=stderr.join().unwrap_or_default();
    Ok(Report{output:if err.is_empty(){out}else{format!("{out}\n{err}")},exit_code:status.code(),elapsed_ms:started.elapsed().as_millis(),timed_out,truncated:a||b})
}
#[tauri::command]
pub async fn run_network_diagnostic(kind:String,target:String,head:bool)->Result<Report,String> {
    tauri::async_runtime::spawn_blocking(move||run(&kind,&target,head)).await.map_err(|e|e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_shell_flags_and_non_http_schemes() {
        for host in ["-c 100","example.com; touch /tmp/x","a b",""] {assert!(arguments("ping",host,false).is_err());}
        for url in ["file:///etc/passwd","https://user:pass@example.com","ftp://example.com"] {assert!(arguments("curl",url,false).is_err());}
        assert!(arguments("shell","ls",false).is_err());
        let (_,args)=arguments("curl","https://example.com/?x=a;b",true).unwrap();
        assert!(args.contains(&"--head".into()));assert_eq!(args.last().unwrap(),"https://example.com/?x=a;b");
    }
    #[test] fn output_is_bounded() {let (out,cut)=read_output(&vec![b'x';100000][..]);assert_eq!(out.len(),32768);assert!(cut);}
    #[test] #[cfg(target_os="macos")] fn curls_local_test_server() {
        use std::io::Write;
        let server=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let addr=server.local_addr().unwrap();
        server.set_nonblocking(true).unwrap();
        let worker=std::thread::spawn(move||{let start=Instant::now();while start.elapsed()<Duration::from_secs(5) {if let Ok((mut socket,_))=server.accept(){socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut b=[0;1024];let _=socket.read(&mut b);let _=socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");return;}std::thread::sleep(Duration::from_millis(10));}});
        let report=run("curl",&format!("http://{addr}"),false).unwrap();worker.join().unwrap();assert_eq!(report.exit_code,Some(0));assert!(report.output.contains("200 OK"));assert!(!report.timed_out);
        let ping=run("ping","127.0.0.1",false).unwrap();assert_eq!(ping.exit_code,Some(0));assert!(ping.output.contains("4 packets transmitted"));
    }
}
