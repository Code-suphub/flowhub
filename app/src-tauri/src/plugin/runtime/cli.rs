//! Production plugin maintenance, limited to inspecting and relocating identical
//! installed packages. No arbitrary RPC, installation, credentials or UI input.
use super::*;
use sha2::{Digest, Sha256};
use std::os::fd::AsRawFd;
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    time::Duration,
};

const MAX_FRAME: u64 = 4 * 1024 * 1024;
const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    List {},
    Verify {
        id: String,
    },
    Migrate {
        id: String,
        #[serde(default)]
        dry_run: bool,
    },
}

fn parse(args: &[String]) -> Result<Request, String> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["list"] => Ok(Request::List {}),
        ["verify", id] if safe_id(id) => Ok(Request::Verify { id: (*id).into() }),
        ["migrate", id] if safe_id(id) => Ok(Request::Migrate {
            id: (*id).into(),
            dry_run: false,
        }),
        ["migrate", id, "--dry-run"] if safe_id(id) => Ok(Request::Migrate {
            id: (*id).into(),
            dry_run: true,
        }),
        _ => Err("用法：plugin list | verify <id> | migrate <id> [--dry-run]".into()),
    }
}

fn frame(stream: &mut UnixStream) -> Result<Value, String> {
    let mut bytes = Vec::new();
    BufReader::new(stream)
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FRAME || bytes.last() != Some(&b'\n') {
        return Err("CLI 响应超限或连接已关闭".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "CLI 消息格式无效".into())
}

fn peer(stream: &UnixStream) -> Result<(), String> {
    let (mut uid, mut gid) = (0, 0);
    let fd = stream.as_raw_fd();
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 || uid != unsafe { libc::geteuid() }
    {
        return Err("CLI 连接不属于当前用户".into());
    }
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut size,
        )
    } != 0
    {
        return Err("无法核对 CLI 进程".into());
    }
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let len = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if len <= 0 {
        return Err("无法读取 CLI 程序路径".into());
    }
    let path = std::ffi::CStr::from_bytes_until_nul(&path).map_err(|_| "CLI 程序路径无效")?;
    use std::os::unix::ffi::OsStrExt;
    let actual = fs::canonicalize(Path::new(std::ffi::OsStr::from_bytes(path.to_bytes())))
        .map_err(|e| e.to_string())?;
    if actual
        != std::env::current_exe()
            .map_err(|e| e.to_string())?
            .canonicalize()
            .map_err(|e| e.to_string())?
    {
        return Err("仅接受当前 FlowHub 安装程序的 CLI 客户端".into());
    }
    Ok(())
}

fn socket(root: &Path) -> PathBuf {
    root.join("cli/control.sock")
}

pub(crate) fn client(args: Vec<String>) -> Result<Value, String> {
    let request = parse(&args)?;
    let root = dirs::data_dir()
        .ok_or("无法确定应用数据目录")?
        .join("FlowHub");
    let mut stream = UnixStream::connect(socket(&root))
        .map_err(|_| "无法连接插件管理 CLI，请先启动支持该能力的 FlowHub 安装版")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    peer(&stream)?;
    writeln!(stream, "{}", serde_json::to_string(&request).unwrap()).map_err(|e| e.to_string())?;
    frame(&mut stream)
}

fn private_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|e| e.to_string())?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err("CLI 目录必须由当前用户持有且不能是符号链接".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

fn listen(root: &Path) -> Result<UnixListener, String> {
    private_dir(&root.join("cli"))?;
    let path = socket(root);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("CLI 路径已被其他文件占用".into());
        }
        match UnixStream::connect(&path) {
            Ok(_) => return Err("插件 CLI 已在运行".into()),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                fs::remove_file(&path).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(listener)
}

pub(crate) fn start(app: tauri::AppHandle) -> Result<(), String> {
    let listener = listen(&app.state::<Runtime>().root)?;
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            let result = peer(&stream)
                .and_then(|_| frame(&mut stream))
                .and_then(|value| {
                    serde_json::from_value::<Request>(value)
                        .map_err(|_| "不支持的插件 CLI 操作".into())
                });
            let result = result.and_then(|request| {
                tauri::async_runtime::block_on(async {
                    app.state::<Runtime>().cli_execute(request).await
                })
            });
            let response = match result {
                Ok(result) => json!({"ok":true,"protocol":1,"result":result}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            let _ = writeln!(stream, "{response}");
        }
    });
    Ok(())
}

fn files(root: &Path) -> Result<BTreeMap<PathBuf, String>, String> {
    fn walk(
        root: &Path,
        path: &Path,
        result: &mut BTreeMap<PathBuf, String>,
        total: &mut u64,
    ) -> Result<(), String> {
        if path.strip_prefix(root).unwrap().components().count() > 32 {
            return Err("插件包目录过深".into());
        }
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                walk(root, &path, result, total)?;
            } else if kind.is_file() {
                if result.len() >= 2000 {
                    return Err("插件包文件过多".into());
                }
                let file = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&path)
                    .map_err(|e| e.to_string())?;
                if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                    return Err("插件包包含特殊文件".into());
                }
                let mut bytes = Vec::new();
                file.take(MAX_BYTES.saturating_sub(*total) + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                *total += bytes.len() as u64;
                if *total > MAX_BYTES {
                    return Err("插件包超过 128 MiB".into());
                }
                result.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    format!("{:x}", Sha256::digest(&bytes)),
                );
            } else {
                return Err("插件包不能包含符号链接或特殊文件".into());
            }
        }
        Ok(())
    }
    use std::os::unix::fs::OpenOptionsExt;
    let metadata = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("插件包目录无效".into());
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result, &mut 0)?;
    Ok(result)
}

fn copy_package(
    source: &Path,
    target: &Path,
    expected: &BTreeMap<PathBuf, String>,
) -> Result<(), String> {
    let parent = target.parent().ok_or("固定安装目录无效")?;
    private_dir(parent)?;
    if target.exists() {
        if files(target)? != *expected {
            return Err("固定安装目录已有不同内容，未覆盖任何文件".into());
        }
        return Ok(());
    }
    let staging = parent.join(format!(
        ".migration-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        for relative in expected.keys() {
            let dest = staging.join(relative);
            fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::copy(source.join(relative), dest).map_err(|e| e.to_string())?;
        }
        if files(&staging)? != *expected {
            return Err("复制期间原插件内容变化，未更新登记".into());
        }
        fs::rename(&staging, target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

impl Runtime {
    async fn cli_health(&self, id: &str) -> Result<Value, String> {
        let session = self.session(id).await?;
        let health = tokio::time::timeout(
            Duration::from_secs(10),
            session.call("health".into(), json!({})),
        )
        .await
        .map_err(|_| "插件启动检查超时")??;
        if !matches!(health["protocol"].as_u64(), Some(1 | 2)) {
            return Err("插件启动检查未返回受支持协议".into());
        }
        Ok(health)
    }

    async fn cli_verify(&self, id: &str) -> Result<Value, String> {
        let installed = self.registered(id)?;
        let package = package(installed.directory.clone())?;
        if json!(installed.manifest) != json!(package.manifest) {
            return Err("插件清单与当前登记不一致".into());
        }
        let inventory = files(&installed.directory)?;
        let health = if installed.enabled {
            self.cli_health(id).await?
        } else {
            Value::Null
        };
        let pid = match self.sessions.lock().await.get(id) {
            Some(s) => s.child.lock().await.id(),
            None => None,
        };
        let summary = if installed.enabled && installed.manifest.status_surface {
            let value = tokio::time::timeout(
                Duration::from_secs(10),
                self.session(id)
                    .await?
                    .call("status_snapshot".into(), json!({})),
            )
            .await
            .map_err(|_| "插件状态读取超时")??;
            json!({"available":value.is_object(),"rows":value["rows"].as_array().map(Vec::len),"at":value["at"]})
        } else {
            Value::Null
        };
        let mail = if id == "twofa" && installed.enabled && mail_allowed(&installed) {
            self.read_mail(|monitor| {
                let value = monitor.status()?;
                Ok(json!({"accounts":value["accounts"].as_array().map(Vec::len)}))
            })?
        } else {
            Value::Null
        };
        Ok(
            json!({"id":id,"version":installed.manifest.version,"directory":installed.directory,"dataDirectory":self.root.join(id),"enabled":installed.enabled,"hostPid":std::process::id(),"pid":pid,"health":health,"status":summary,"mail":mail,"packageFiles":inventory.len(),"entryAssetsVerified":true}),
        )
    }

    async fn cli_execute(&self, request: Request) -> Result<Value, String> {
        let _mutation = self
            .package_lock
            .try_lock()
            .map_err(|_| "其他插件操作尚未完成，请稍后重试")?;
        match request {
            Request::List {} => Ok(self.list()),
            Request::Verify { id } => self.cli_verify(&id).await,
            Request::Migrate { id, dry_run } => {
                if !safe_id(&id) {
                    return Err("插件 ID 无效".into());
                }
                let old = self.registered(&id)?;
                if matches!(old.origin, Some(InstallOrigin::Market { .. }))
                    || old.directory.starts_with(self.root.join("plugin-packages"))
                {
                    return Err("市场安装包已由宿主管理，无需迁移本地目录".into());
                }
                let checked = package(old.directory.clone())?;
                if json!(checked.manifest) != json!(old.manifest) {
                    return Err("原目录清单已变化，请先通过插件市场核对更新".into());
                }
                let expected = files(&old.directory)?;
                let target = self.root.join("local-plugins").join(&id);
                if target.exists() && files(&target)? != expected {
                    return Err("固定安装目录已有不同内容，未覆盖任何文件".into());
                }
                let preview = json!({"id":id,"version":old.manifest.version,"from":old.directory,"to":target,"enabled":old.enabled,"files":expected.len(),"alreadyManaged":old.directory==target,"dryRun":dry_run});
                if dry_run {
                    return Ok(preview);
                }
                if old.directory == target {
                    return self.cli_verify(&id).await;
                }
                // All validation/copying finishes before touching the live session.
                copy_package(&old.directory, &target, &expected)?;
                let mut next = old.clone();
                next.directory = target;
                next.origin = Some(InstallOrigin::Directory);
                if old.enabled {
                    next.last_loaded_at = Some(
                        chrono::Utc::now()
                            .timestamp_millis()
                            .max(old.last_loaded_at.unwrap_or(0).saturating_add(1)),
                    );
                }
                self.stop(&id).await;
                if let Err(error) = self.update(|items| {
                    if let Some(item) = items.iter_mut().find(|p| p.manifest.id == id) {
                        *item = next;
                    }
                }) {
                    if old.enabled {
                        let _ = self.cli_health(&id).await;
                    }
                    return Err(error);
                }
                let result = self.cli_verify(&id).await;
                if let Err(error) = result {
                    self.stop(&id).await;
                    self.update(|items| {
                        if let Some(item) = items.iter_mut().find(|p| p.manifest.id == id) {
                            *item = old.clone();
                        }
                    })?;
                    if old.enabled {
                        let _ = self.cli_health(&id).await;
                    }
                    return Err(format!("迁移检查失败，已恢复原安装目录：{error}"));
                }
                Ok(json!({"migration":preview,"verified":result?}))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = PathBuf::from("/tmp").join(format!(
                "fhcli-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(enabled: bool, fail_after_move: bool) -> (Temp, Runtime, PathBuf) {
        let root = Temp::new();
        let directory = root.0.join("package");
        fs::create_dir_all(directory.join("ui")).unwrap();
        fs::write(directory.join("ui/index.html"), "<p>fixture</p>").unwrap();
        let guard = if fail_after_move {
            "case \"$PWD\" in */local-plugins/*) exit 1;; esac\n"
        } else {
            ""
        };
        fs::write(directory.join("service"), format!("#!/bin/sh\n{guard}while IFS= read -r line; do id=$(printf '%s' \"$line\" | sed 's/.*\"id\":\\([0-9]*\\).*/\\1/'); printf '{{\"id\":%s,\"result\":{{\"protocol\":2}}}}\\n' \"$id\"; done\n")).unwrap();
        fs::set_permissions(directory.join("service"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(directory.join("flowhub-plugin.json"), json!({"schema":2,"id":"fixture","name":"Fixture","version":"1.0.0","ui":"ui/index.html","executable":"service","permissions":["native-process"]}).to_string()).unwrap();
        let mut installed = package(directory.clone()).unwrap();
        installed.enabled = enabled;
        let rt = Runtime::new(root.0.clone()).unwrap();
        rt.update(|items| items.push(installed)).unwrap();
        fs::create_dir_all(root.0.join("fixture")).unwrap();
        fs::write(
            root.0.join("fixture/settings.json"),
            b"retained configuration",
        )
        .unwrap();
        (root, rt, directory)
    }

    #[test]
    fn cli_accepts_only_documented_commands_and_ids() {
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(matches!(parse(&args(&["list"])), Ok(Request::List {})));
        assert!(matches!(
            parse(&args(&["migrate", "docker", "--dry-run"])),
            Ok(Request::Migrate { dry_run: true, .. })
        ));
        for a in [
            vec!["install", "x"],
            vec!["migrate", "../escape"],
            vec!["verify", "x", "--force"],
        ] {
            assert!(parse(&args(&a)).is_err());
        }
    }
    #[test]
    fn private_socket_recovers_stale_socket_but_never_overwrites_files() {
        let root = Temp::new();
        let listener = listen(&root.0).unwrap();
        assert_eq!(
            fs::metadata(socket(&root.0)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(listen(&root.0).is_err());
        drop(listener);
        drop(listen(&root.0).unwrap());
        fs::remove_file(socket(&root.0)).unwrap();
        fs::write(socket(&root.0), "preserve").unwrap();
        assert!(listen(&root.0).is_err());
        assert_eq!(fs::read(socket(&root.0)).unwrap(), b"preserve");
    }
    #[test]
    fn peer_identity_and_truncated_frames_are_checked() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        peer(&a).unwrap();
        b.write_all(b"{\"action\":\"list\"}").unwrap();
        drop(b);
        assert!(frame(&mut a).is_err());
    }
    #[test]
    fn another_local_program_cannot_use_the_maintenance_socket() {
        let root = Temp::new();
        let listener = listen(&root.0).unwrap();
        let mut child = std::process::Command::new("/usr/bin/nc")
            .args(["-U", socket(&root.0).to_str().unwrap()])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let (stream, _) = listener.accept().unwrap();
        assert!(peer(&stream).is_err());
        drop(stream);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            serde_json::from_value::<Request>(json!({"action":"rpc","method":"mail_copy"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<Request>(json!({"action":"list","method":"mail_copy"}))
                .is_err()
        );
    }
    #[tokio::test]
    async fn dry_run_preserves_session_and_migration_retains_data_and_restarts_from_fixed_path() {
        let (root, rt, old) = fixture(true, false);
        let session = rt.session("fixture").await.unwrap();
        rt.cli_health("fixture").await.unwrap();
        let registry = fs::read(root.0.join("plugins.json")).unwrap();
        let preview = rt
            .cli_execute(Request::Migrate {
                id: "fixture".into(),
                dry_run: true,
            })
            .await
            .unwrap();
        assert_eq!(preview["from"], json!(old));
        assert!(!root.0.join("local-plugins").exists());
        assert_eq!(fs::read(root.0.join("plugins.json")).unwrap(), registry);
        assert!(Arc::ptr_eq(&session, &rt.session("fixture").await.unwrap()));
        let migrated = rt
            .cli_execute(Request::Migrate {
                id: "fixture".into(),
                dry_run: false,
            })
            .await
            .unwrap();
        assert_eq!(migrated["verified"]["health"]["protocol"], 2);
        assert_eq!(
            rt.registered("fixture").unwrap().directory,
            root.0.join("local-plugins/fixture")
        );
        assert!(!Arc::ptr_eq(
            &session,
            &rt.session("fixture").await.unwrap()
        ));
        assert_eq!(
            fs::read(root.0.join("fixture/settings.json")).unwrap(),
            b"retained configuration"
        );
        assert_eq!(
            files(&old).unwrap(),
            files(&root.0.join("local-plugins/fixture")).unwrap()
        );
        rt.cli_execute(Request::Migrate {
            id: "fixture".into(),
            dry_run: false,
        })
        .await
        .unwrap();
        rt.stop("fixture").await;
    }
    #[tokio::test]
    async fn failed_destination_health_rolls_back_original_registration_and_process() {
        let (root, rt, old) = fixture(true, true);
        let error = rt
            .cli_execute(Request::Migrate {
                id: "fixture".into(),
                dry_run: false,
            })
            .await
            .unwrap_err();
        assert!(error.contains("已恢复原安装目录"));
        assert_eq!(rt.registered("fixture").unwrap().directory, old);
        rt.cli_health("fixture").await.unwrap();
        assert_eq!(
            fs::read(root.0.join("fixture/settings.json")).unwrap(),
            b"retained configuration"
        );
        rt.stop("fixture").await;
    }
    #[tokio::test]
    async fn different_or_linked_destination_is_refused_and_disabled_plugin_stays_disabled() {
        let (root, rt, _) = fixture(false, false);
        let target = root.0.join("local-plugins/fixture");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep"), "different").unwrap();
        assert!(rt
            .cli_execute(Request::Migrate {
                id: "fixture".into(),
                dry_run: false
            })
            .await
            .is_err());
        assert_eq!(fs::read(target.join("keep")).unwrap(), b"different");
        fs::remove_dir_all(&target).unwrap();
        symlink(root.0.join("package"), &target).unwrap();
        assert!(rt
            .cli_execute(Request::Migrate {
                id: "fixture".into(),
                dry_run: false
            })
            .await
            .is_err());
        fs::remove_file(&target).unwrap();
        rt.cli_execute(Request::Migrate {
            id: "fixture".into(),
            dry_run: false,
        })
        .await
        .unwrap();
        assert!(!rt.registered("fixture").unwrap().enabled);
        assert!(rt.sessions.lock().await.is_empty());
    }
}
