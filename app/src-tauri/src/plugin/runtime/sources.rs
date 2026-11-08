use super::*;
use sha2::{Digest,Sha256};
use base64::Engine;
mod official;
#[derive(Clone,Serialize,Deserialize)]
pub(super) struct Source {id:String,name:String,kind:String,location:String,#[serde(default)] key:String}
#[derive(Clone,Serialize,Deserialize)]
pub(super) struct Candidate {token:String,source:String,manifest:Manifest,#[serde(default)]directory:Option<PathBuf>,#[serde(default)]url:String,#[serde(default)]sha256:String,#[serde(default)]signature:String,#[serde(default)]target:String,#[serde(default,rename="releaseNotes")]release_notes:String,#[serde(default,rename="publishedAt")]published_at:String}
fn digest(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
// Plugin releases use native minisign text; retain compatibility with sources
// that wrap their keys/signatures in Base64 like Tauri updater metadata.
fn verify_package(data:&[u8],signature:&str,pubkey:&str)->Result<(),String>{
    let decode=|text:&str|->Result<String,String>{
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
    };
    let key=minisign_verify::PublicKey::decode(pubkey.trim()).or_else(|_|minisign_verify::PublicKey::from_base64(pubkey.trim())).map_err(|e|e.to_string())
        .or_else(|_|minisign_verify::PublicKey::decode(&decode(pubkey)?).map_err(|e|e.to_string()))?;
    let signature=minisign_verify::Signature::decode(signature.trim()).map_err(|e|e.to_string())
        .or_else(|_|minisign_verify::Signature::decode(&decode(signature)?).map_err(|e|e.to_string()))?;
    key.verify(data,&signature,true).map_err(|e|e.to_string())
}
pub(super) fn load(root:&Path)->Result<Vec<Source>,String>{
    let path=root.join("plugin-sources.json");
    if path.exists(){return serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|format!("插件来源配置损坏：{e}"));}
    // Migrate source definitions only. Old schema 1 packages remain incompatible.
    let old=std::fs::read(root.join("machines/state.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
    let mut result=Vec::new();
    if let Some(folders)=old["folders"].as_array(){for folder in folders.iter().filter_map(Value::as_str){result.push(Source{id:digest(folder.as_bytes()),name:"原本地来源".into(),kind:"local".into(),location:folder.into(),key:String::new()});}}
    let mut remotes=old["sources"].as_array().cloned().unwrap_or_default();if old["source"].is_object(){remotes.push(old["source"].clone());}
    for remote in remotes {if let Some(url)=remote["url"].as_str(){if !result.iter().any(|s|s.location==url){result.push(Source{id:digest(url.as_bytes()),name:"原线上来源".into(),kind:"https".into(),location:url.into(),key:remote["key"].as_str().unwrap_or("").into()});}}}
    if !result.is_empty(){crate::storage::write_json_atomic(&path,&json!(result))?;}Ok(result)
}
fn validate_url(value:&str)->Result<(),String>{let url=reqwest::Url::parse(value).map_err(|_|"仓库地址无效")?;if url.scheme()!="https"||!url.username().is_empty()||url.password().is_some(){return Err("仓库和下载地址必须使用无嵌入凭据的 HTTPS URL".into());}Ok(())}
async fn download(url:&str,limit:usize)->Result<Vec<u8>,String>{
    download_progress(url,limit,|_,_|{}).await
}
async fn download_progress(url:&str,limit:usize,mut progress:impl FnMut(usize,Option<u64>))->Result<Vec<u8>,String>{
    validate_url(url)?;
    let _=rustls::crypto::ring::default_provider().install_default();
    let client=reqwest::Client::builder().user_agent("FlowHub/plugin-market").https_only(true).redirect(reqwest::redirect::Policy::limited(5)).timeout(std::time::Duration::from_secs(90)).build().map_err(|e|e.to_string())?;
    let response=client.get(url).send().await.map_err(|e|e.to_string())?;
    if matches!(response.status().as_u16(),403|429){return Err("公开目录或安装包访问受限，请稍后重试（HTTP 403/429）".into());}
    let mut response=response.error_for_status().map_err(|e|e.to_string())?;
    let total=response.content_length();if total.is_some_and(|n|n>limit as u64){return Err("仓库或插件包超过大小限制".into());}
    let mut last=std::time::Instant::now();progress(0,total);
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|e|e.to_string())?{if bytes.len()+chunk.len()>limit{return Err("仓库或插件包超过大小限制".into());}bytes.extend_from_slice(&chunk);if last.elapsed().as_millis()>=150{progress(bytes.len(),total);last=std::time::Instant::now();}}progress(bytes.len(),total);Ok(bytes)
}
fn validate_manifest(m:&Manifest)->Result<(),String>{
    if m.schema!=2||!safe_id(&m.id)||!super::valid_permissions(&m.id,&m.permissions){return Err("插件需要 schema 2 原生进程格式".into());}
    semver::Version::parse(&m.version).map_err(|e|e.to_string())?;Ok(())
}
fn candidate(source:&Source,manifest:Manifest,directory:Option<PathBuf>)->Candidate {
    let token=digest(format!("{}:{}:{}:{:?}",source.id,manifest.id,manifest.version,directory).as_bytes());
    Candidate{token,source:source.id.clone(),manifest,directory,url:String::new(),sha256:String::new(),signature:String::new(),target:String::new(),release_notes:String::new(),published_at:String::new()}
}
fn parse_catalog(source:&Source,catalog:&Value,target:&str)->Result<(Vec<Candidate>,Vec<String>),String>{
    if catalog["schema"]!=2{return Err("此来源需要 schema 2 独立插件索引".into());}
    let entries=catalog["plugins"].as_array().ok_or("索引缺少 plugins")?;if entries.len()>500{return Err("仓库插件过多".into());}
    let mut found=Vec::new();let mut warnings=Vec::new();
    for entry in entries {
        let manifest:Manifest=serde_json::from_value(entry["manifest"].clone()).map_err(|_|"仓库插件清单无效")?;validate_manifest(&manifest)?;
        if entry["target"].as_str()!=Some(target){warnings.push(format!("{}：无适用于 {target} 的安装包",manifest.name));continue;}
        let mut c=candidate(source,manifest,None);c.url=entry["url"].as_str().ok_or("缺少下载地址")?.into();validate_url(&c.url)?;
        c.sha256=entry["sha256"].as_str().ok_or("缺少包校验值")?.into();c.signature=entry["signature"].as_str().ok_or("缺少包签名")?.into();c.target=target.into();c.token=digest(format!("{}:{}:{}",c.token,c.url,c.sha256).as_bytes());
        c.release_notes=entry["releaseNotes"].as_str().unwrap_or("").chars().take(20_000).collect();c.published_at=entry["publishedAt"].as_str().unwrap_or("").into();found.push(c);
    }Ok((found,warnings))
}
fn report(progress:Option<&tauri::ipc::Channel<Value>>,phase:&str,received:usize,total:Option<u64>){if let Some(channel)=progress{let _=channel.send(json!({"phase":phase,"received":received,"total":total}));}}
// Every error after extraction (including changed sources and failed persistence)
// removes the uncommitted directory. The previous installed record stays intact.
struct StagedDirectory(Option<PathBuf>);
impl Drop for StagedDirectory {fn drop(&mut self){if let Some(path)=self.0.take(){let _=std::fs::remove_dir_all(path);}}}
fn commit_package(rt:&Runtime,source:&Source,expected:&Manifest,package:Installed,staged:&mut StagedDirectory)->Result<Value,String>{
    // Hold source configuration stable through the atomic manifest replacement.
    let sources=rt.sources.lock().unwrap();
    if !sources.iter().any(|s|s.id==source.id && s.location==source.location && s.key==source.key){return Err("来源已变更，请重新扫描后安装".into());}
    if serde_json::to_value(&package.manifest).unwrap()!=serde_json::to_value(expected).unwrap(){return Err("安装包与索引清单不一致，请重新扫描".into());}
    let result=rt.update(|items|{let mut package=package;package.origin=Some(InstallOrigin::Market{source:Some(source.id.clone())});if let Some(old)=items.iter().find(|p|p.manifest.id==package.manifest.id){package.enabled=old.enabled;}items.retain(|p|p.manifest.id!=package.manifest.id);items.push(package);})?;
    staged.0=None;Ok(result)
}
fn scan_local(source:&Source)->Result<(Vec<Candidate>,Vec<String>),String>{
    let root=PathBuf::from(&source.location).canonicalize().map_err(|e|e.to_string())?;
    let mut dirs=Vec::new();let mut warnings=Vec::new();
    if root.join("flowhub-plugin.json").exists(){dirs.push(root.clone());}else{
        for child in std::fs::read_dir(&root).map_err(|e|e.to_string())?.take(257){let child=child.map_err(|e|e.to_string())?;if child.file_type().map_err(|e|e.to_string())?.is_dir() && child.path().join("flowhub-plugin.json").exists(){dirs.push(child.path());}}
    }
    let mut found=Vec::new();for path in dirs{match package(path.clone()){Ok(p)=>found.push(candidate(source,p.manifest,Some(p.directory))),Err(e)=>warnings.push(format!("{}：{e}",path.display()))}}
    if found.is_empty(){warnings.push("未找到已构建的 schema 2 插件；旧版 package.json 声明式包需要升级。".into());}Ok((found,warnings))
}
fn unpack(bytes:&[u8],directory:&Path)->Result<(),String>{
    use std::{io::Write,os::unix::fs::OpenOptionsExt};
    let bundle:Value=serde_json::from_slice(bytes).map_err(|_|"插件包不是有效 JSON")?;
    if bundle["schema"]!=2{return Err("插件包版本不支持".into());}
    let files=bundle["files"].as_object().ok_or("插件包缺少文件")?;if files.len()>2000{return Err("插件文件过多".into());}
    let mut total=0;
    for (name,encoded) in files{
        let relative=Path::new(name);if name.is_empty()||relative.components().any(|c|!matches!(c,std::path::Component::Normal(_))){return Err("插件包含有越界路径".into());}
        let bytes=base64::engine::general_purpose::STANDARD.decode(encoded.as_str().ok_or("插件文件编码无效")?).map_err(|_|"插件文件编码无效")?;
        total+=bytes.len();if total>128*1024*1024{return Err("插件解包超过 128 MiB".into());}
        let target=directory.join(relative);std::fs::create_dir_all(target.parent().unwrap()).map_err(|e|e.to_string())?;
        let mut f=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(target).map_err(|e|e.to_string())?;f.write_all(&bytes).map_err(|e|e.to_string())?;
    }Ok(())
}
pub(super) async fn api(rt:&Runtime,app:&tauri::AppHandle,action:&str,p:&Value,progress:Option<&tauri::ipc::Channel<Value>>)->Result<Value,String>{
    match action{
        "sources"=>Ok(json!(rt.sources.lock().unwrap().clone())),
        "chooseSource"=>{let(tx,rx)=tokio::sync::oneshot::channel();app.dialog().file().set_title("选择插件来源目录").pick_folder(move|path|{let _=tx.send(path);});Ok(match rx.await.map_err(|e|e.to_string())?{Some(path)=>json!(path.into_path().map_err(|e|e.to_string())?),None=>Value::Null})},
        "saveSource"|"removeSource"=>{
            let mut sources=rt.sources.lock().unwrap();let mut next=sources.clone();let id=p["id"].as_str().unwrap_or("");
            if action=="removeSource"{next.retain(|s|s.id!=id);}else{
                let mut source:Source=serde_json::from_value(p.clone()).map_err(|_|"来源字段不完整")?;
                if source.name.trim().is_empty()||source.name.len()>100{return Err("请输入来源名称（最多 100 字符）".into());}
                match source.kind.as_str(){"local"=>{source.location=PathBuf::from(source.location).canonicalize().map_err(|e|e.to_string())?.to_string_lossy().into_owned();},"https"=>{validate_url(&source.location)?;if source.key.trim().is_empty(){return Err("线上来源需要 minisign 公钥".into());}},_=>return Err("不支持的来源类型".into())}
                if source.id.is_empty(){source.id=digest(format!("{}:{}",source.kind,source.location).as_bytes());}else if !sources.iter().any(|s|s.id==source.id){return Err("来源不存在，请重新添加".into());}
                next.retain(|s|s.id!=source.id);next.push(source);
            }
            crate::storage::write_json_atomic(&rt.root.join("plugin-sources.json"),&json!(next))?;*sources=next;rt.candidates.lock().unwrap().clear();Ok(json!(*sources))
        }
        "scanSource"=>{
            let source=rt.sources.lock().unwrap().iter().find(|s|Some(s.id.as_str())==p["id"].as_str()).cloned().ok_or("来源不存在")?;
            let (found,warnings)=if source.kind=="local"{scan_local(&source)?}else if source.location==official::INDEX{tokio::time::timeout(std::time::Duration::from_secs(120),official::scan(&source)).await.map_err(|_|"官方库读取超时，请稍后重试")??}else{
                let bytes=download(&source.location,2*1024*1024).await?;let catalog:Value=serde_json::from_slice(&bytes).map_err(|_|"仓库索引格式无效")?;
                parse_catalog(&source,&catalog,&format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH))?
            };
            if !rt.sources.lock().unwrap().iter().any(|s|s.id==source.id && s.location==source.location && s.key==source.key){return Err("来源已更改，请重新扫描".into());}
            let mut candidates=rt.candidates.lock().unwrap();candidates.retain(|_,c|c.source!=source.id);for c in &found{candidates.insert(c.token.clone(),c.clone());}Ok(json!({"plugins":found,"warnings":warnings}))
        }
        "installCandidate"=>{
            let c=rt.candidates.lock().unwrap().get(p["token"].as_str().unwrap_or("")).cloned().ok_or("安装候选已失效，请重新扫描")?;
            let source=rt.sources.lock().unwrap().iter().find(|s|s.id==c.source).cloned().ok_or("来源已移除")?;
            let mut staged=StagedDirectory(None);report(progress,"preparing",0,None);
            let package=if let Some(directory)=c.directory{package(directory)?}else{
                let bytes=download_progress(&c.url,192*1024*1024,|received,total|report(progress,"downloading",received,total)).await?;
                report(progress,"verifying",bytes.len(),None);if digest(&bytes)!=c.sha256{return Err("插件包校验失败".into());}verify_package(&bytes,&c.signature,&source.key).map_err(|error|format!("安装包签名验证失败：{error}"))?;
                report(progress,"extracting",0,None);
                let directory=rt.root.join("plugin-packages").join(format!("{}-{}",c.manifest.id,chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
                staged.0=Some(directory.clone());
                let result=(||{unpack(&bytes,&directory)?;let p=package(directory.clone())?;use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(inside(&p.directory,&p.manifest.executable)?,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;Ok::<_,String>(p)})();
                match result{Ok(p)=>p,Err(e)=>{let _=std::fs::remove_dir_all(directory);return Err(e);}}
            };
            if !rt.sources.lock().unwrap().iter().any(|s|s.id==source.id && s.location==source.location && s.key==source.key){return Err("来源已变更，请重新扫描后安装".into());}
            if serde_json::to_value(&package.manifest).unwrap()!=serde_json::to_value(&c.manifest).unwrap(){return Err("安装包与索引清单不一致，请重新扫描".into());}
            report(progress,"applying",0,None);rt.stop(&package.manifest.id).await;
            let result=commit_package(rt,&source,&c.manifest,package,&mut staged)?;
            report(progress,"complete",0,None);Ok(result)
        }
        _=>Err("未知来源操作".into())
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn updates_preserve_disabled_state_and_data_and_failed_commits_remove_staging(){
        let root=std::env::temp_dir().join(format!("plugin-update-test-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&root).unwrap();
        let rt=Runtime::new(root.clone()).unwrap();
        let source=Source{id:"test".into(),name:"test".into(),kind:"https".into(),location:"https://example.test/catalog.json".into(),key:"pinned".into()};rt.sources.lock().unwrap().push(source.clone());
        let manifest:Manifest=serde_json::from_value(json!({"schema":2,"id":"example","name":"Example","version":"1.0.0","ui":"ui/index.html","executable":"bin/run","permissions":["native-process"]})).unwrap();
        let old=root.join("old-package");std::fs::create_dir_all(&old).unwrap();std::fs::write(old.join("keep"),"old executable").unwrap();
        let data=root.join("example");std::fs::create_dir_all(&data).unwrap();std::fs::write(data.join("config.json"),"user data").unwrap();
        rt.update(|items|items.push(Installed{manifest:manifest.clone(),directory:old.clone(),enabled:false,last_loaded_at:None,origin:None})).unwrap();
        let mut next=manifest.clone();next.version="2.0.0".into();
        let prepare=|name:&str|{let path=root.join(name);std::fs::create_dir_all(&path).unwrap();(Installed{manifest:next.clone(),directory:path.clone(),enabled:true,last_loaded_at:None,origin:None},StagedDirectory(Some(path)))};
        {
            let (package,mut staged)=prepare("mismatch");assert!(commit_package(&rt,&source,&manifest,package,&mut staged).is_err());
        }
        assert!(!root.join("mismatch").exists());assert_eq!(rt.list()[0]["manifest"]["version"],"1.0.0");
        {
            let (package,mut staged)=prepare("changed-source");rt.sources.lock().unwrap().clear();assert!(commit_package(&rt,&source,&next,package,&mut staged).is_err());rt.sources.lock().unwrap().push(source.clone());
        }
        assert!(!root.join("changed-source").exists());
        std::fs::remove_file(root.join("plugins.json")).unwrap();std::fs::create_dir(root.join("plugins.json")).unwrap();
        {
            let (package,mut staged)=prepare("failed-write");assert!(commit_package(&rt,&source,&next,package,&mut staged).is_err());
        }
        assert!(!root.join("failed-write").exists());assert_eq!(rt.list()[0]["manifest"]["version"],"1.0.0");assert!(old.join("keep").exists());
        std::fs::remove_dir(root.join("plugins.json")).unwrap();
        {
            let (package,mut staged)=prepare("success");commit_package(&rt,&source,&next,package,&mut staged).unwrap();
        }
        assert!(root.join("success").exists());assert_eq!(rt.list()[0]["manifest"]["version"],"2.0.0");assert_eq!(rt.list()[0]["enabled"],false);assert_eq!(std::fs::read_to_string(data.join("config.json")).unwrap(),"user data");
        assert_eq!(rt.list()[0]["origin"],json!({"kind":"market","source":"test"}));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn plugin_signatures_accept_native_and_encoded_minisign_but_reject_tampering(){
        // Public test vector from minisign-verify 0.2.5 (MIT), also used by the updater tests.
        let key="untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature="untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let encode=|s:&str|base64::engine::general_purpose::STANDARD.encode(s);
        for key in [key.to_string(),key.lines().nth(1).unwrap().to_string(),encode(key)]{
            for signature in [signature.to_string(),encode(signature)]{
                assert!(verify_package(b"test",&signature,&key).is_ok());
                assert!(verify_package(b"Test",&signature,&key).is_err());
            }
        }
        assert!(verify_package(b"test","invalid signature",key).is_err());
        assert!(verify_package(b"test",signature,"invalid key").is_err());
    }
    #[test]
    fn sources_migrate_scan_without_execution_and_reject_unsafe_packages(){
        let root=std::env::temp_dir().join(format!("source-test-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(root.join("machines")).unwrap();
        std::fs::write(root.join("machines/state.json"),json!({"folders":[root.join("packages")],"sources":[{"url":"https://example.test/catalog.json","key":"public-key"}]}).to_string()).unwrap();
        let sources=load(&root).unwrap();assert_eq!(sources.len(),2);assert_eq!(load(&root).unwrap().len(),2);
        let directory=root.join("packages/test");std::fs::create_dir_all(&directory).unwrap();
        let manifest=json!({"schema":2,"id":"example","name":"Example","version":"1.0.0","ui":"ui/index.html","executable":"bin/run","permissions":["native-process"]});
        let bundle=json!({"schema":2,"files":{"flowhub-plugin.json":base64::engine::general_purpose::STANDARD.encode(manifest.to_string()),"ui/index.html":base64::engine::general_purpose::STANDARD.encode("hello"),"bin/run":base64::engine::general_purpose::STANDARD.encode("not executed")}});
        unpack(bundle.to_string().as_bytes(),&directory).unwrap();let (found,warnings)=scan_local(&sources[0]).unwrap();assert_eq!(found.len(),1);assert!(warnings.is_empty());assert_eq!(found[0].manifest.id,"example");
        assert!(validate_url("http://example.test/catalog.json").is_err());assert!(validate_url("https://user:secret@example.test").is_err());
        let bad=json!({"schema":2,"files":{"../escape":"eA=="}});assert!(unpack(bad.to_string().as_bytes(),&directory).is_err());assert!(!root.join("packages/escape").exists());
        let legacy=json!({"schema":1,"files":{}});assert!(unpack(legacy.to_string().as_bytes(),&directory).is_err());std::fs::remove_dir_all(root).unwrap();
    }
}
