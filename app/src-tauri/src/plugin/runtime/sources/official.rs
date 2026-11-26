use super::*;
use std::{collections::BTreeMap, future::Future, sync::Mutex, time::Duration};
use tokio::time::{timeout, timeout_at, Instant};

// GitHub's public Releases feed is the aggregate source; no separate registry
// service or publishing step is needed. Package trust still uses a pinned key.
pub(super) const INDEX:&str="https://api.github.com/repos/Code-suphub/flowhub-plugins/releases?per_page=100";
pub(super) const KEY:&str="RWQIJOnosHIl5QGJ83XSe/Mx8aIvANKnnSUDpzVVNxCAZjTR+cBm1Jne";
const PREFIX:&str="https://github.com/Code-suphub/flowhub-plugins/releases/download/";
const RELEASE_LIST_TIMEOUT: Duration = Duration::from_secs(12);
const CATALOG_TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const CATALOG_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone)]
struct Release { id:String,version:semver::Version,catalog:String,notes:String,published:String }
fn eligible(release:&Value,target:&str)->Option<Release>{
    if release["draft"]==true || release["prerelease"]==true {return None;}
    let tag=release["tag_name"].as_str()?;
    let (id,version)=tag.rsplit_once("-v")?;
    let version=semver::Version::parse(version).ok()?;
    if !safe_id(id) || !version.pre.is_empty(){return None;}
    let assets=release["assets"].as_array()?;
    let package_name=format!("{id}-{version}-{target}.fhplugin");
    let expected=format!("{PREFIX}{tag}/catalog.json");
    if !assets.iter().any(|a|a["name"].as_str()==Some(&package_name)) ||
        !assets.iter().any(|a|a["name"]=="catalog.json" && a["browser_download_url"].as_str()==Some(&expected)){
        return None;
    }
    Some(Release{id:id.into(),version,catalog:expected,notes:release["body"].as_str().unwrap_or("").chars().take(20_000).collect(),published:release["published_at"].as_str().unwrap_or("").into()})
}
fn select(releases:&Value,target:&str)->Result<Vec<Release>,String>{
    let rows=releases.as_array().ok_or("官方发布列表格式无效")?;
    let mut latest:BTreeMap<String,Release>=BTreeMap::new();
    for release in rows {
        let Some(release)=eligible(release,target) else{continue};
        if latest.get(&release.id).is_some_and(|old|old.version>=release.version){continue;}
        latest.insert(release.id.clone(),release);
    }
    if latest.len()>100{return Err("官方插件数量超过读取上限".into());}
    Ok(latest.into_values().collect())
}
async fn releases(client:&reqwest::Client)->Result<(Vec<Value>,bool),String>{
    let mut all=Vec::new();let mut bounded=false;
    for page in 1..=5 {
        let bytes=download_with_client(client,&format!("{INDEX}&page={page}"),4*1024*1024,|_,_|{}).await?;
        let list:Value=serde_json::from_slice(&bytes).map_err(|_|"官方发布列表格式无效")?;
        let rows=list.as_array().ok_or("官方发布列表格式无效")?;
        let count=rows.len();all.extend(rows.iter().cloned());
        if count<100 {break;}
        if page==5 {bounded=true;}
    }
    Ok((all,bounded))
}

fn history_for(rows:&[Value],id:&str,target:&str)->Vec<Value>{
    let mut versions:BTreeMap<_,_>=BTreeMap::new();
    for row in rows {
        if row["tag_name"].as_str().and_then(|tag|tag.rsplit_once("-v")).map(|(name,_)|name)!=Some(id){continue;}
        if let Some(release)=eligible(row,target){versions.entry(release.version).or_insert((release.published,release.notes));}
    }
    versions.into_iter().rev().take(5).map(|(version,(published,notes))|
        json!({"version":version.to_string(),"publishedAt":published,"releaseNotes":notes})
    ).collect()
}

pub(super) async fn history(id:&str)->Result<Value,String>{
    let (rows,bounded)=releases(&download_client()?).await?;
    let target=format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH);
    Ok(json!({"releases":history_for(&rows,id,&target),"bounded":bounded}))
}

async fn load_catalog(client:&reqwest::Client,source:&Source,target:&str,release:Release)->Result<Candidate,String>{
    let bytes=download_with_client(client,&release.catalog,2*1024*1024,|_,_|{}).await?;
    let catalog:Value=serde_json::from_slice(&bytes).map_err(|_|"插件目录格式无效")?;
    let (mut plugins,_)=parse_catalog(source,&catalog,target)?;
    plugins.retain(|c|c.manifest.id==release.id && c.manifest.version==release.version.to_string());
    if plugins.len()!=1{return Err("发布版本与目录中的插件不一致".into());}
    let mut c=plugins.remove(0);
    let expected=format!("{PREFIX}{}-v{}/{}-{}-{target}.fhplugin",release.id,release.version,release.id,release.version);
    if c.url!=expected{return Err("官方安装包地址与发布版本不一致".into());}
    c.release_notes=release.notes;
    c.published_at=release.published;
    Ok(c)
}

async fn read_catalogs<F,Fut>(selected:Vec<Release>,load:F)->Vec<(String,Result<Candidate,String>)>
where F:Fn(Release)->Fut, Fut:Future<Output=Result<Candidate,String>> {
    let pending=Mutex::new(selected.into_iter());
    let deadline=Instant::now()+CATALOG_TOTAL_TIMEOUT;
    // Four workers share the queue so a slow asset does not delay the next
    // catalog on another worker. Keep successful results when the budget ends.
    let worker=||async {
        let mut outcomes=Vec::new();
        loop {
            let next=pending.lock().unwrap().next();
            let Some(release)=next else { return outcomes; };
            let id=release.id.clone();
            let now=Instant::now();
            let result=if now>=deadline {
                Err("官方目录检查超时，请重试".into())
            } else {
                timeout_at(deadline.min(now+CATALOG_REQUEST_TIMEOUT),load(release)).await
                    .unwrap_or_else(|_|Err("官方目录读取超时，请重试".into()))
            };
            outcomes.push((id,result));
        }
    };
    let (first,second,third,fourth)=tokio::join!(worker(),worker(),worker(),worker());
    let mut outcomes:Vec<_>=first.into_iter().chain(second).chain(third).chain(fourth).collect();
    outcomes.sort_unstable_by(|a,b|a.0.cmp(&b.0));
    outcomes
}

pub(super) async fn scan(source:&Source)->Result<(Vec<Candidate>,Vec<String>),String>{
    // A source with a different key must never gain the official identity.
    let bare=source.key.trim().lines().find(|line|!line.starts_with("untrusted comment:")).unwrap_or("");
    let key=minisign_verify::PublicKey::from_base64(bare).map_err(|_|"官方库公钥无效，请重新连接官方库")?;
    let pinned=minisign_verify::PublicKey::from_base64(KEY).unwrap();
    // Both native text and bare public-key forms are accepted by verification.
    if key!=pinned{return Err("官方库公钥与内置公钥不一致，请检查来源设置".into());}
    let target=format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH);
    let client=download_client()?;
    let (all,bounded)=timeout(RELEASE_LIST_TIMEOUT,releases(&client)).await
        .map_err(|_|"GitHub 发布列表读取超时，请在来源设置重试")??;
    let selected=select(&json!(all),&target)?;
    let mut found=Vec::new();let mut warnings=Vec::new();
    if bounded{warnings.push("仅检查最近 500 个公开发布；更早的版本未读取。".into());}
    for (id,result) in read_catalogs(selected,|release|load_catalog(&client,source,&target,release)).await {
        match result {Ok(c)=>found.push(c),Err(error)=>warnings.push(format!("{id}：{error}"))}
    }
    if found.is_empty() && warnings.is_empty(){warnings.push(format!("官方库暂无适用于 {target} 的稳定版本。"));}
    Ok((found,warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag:&str,targets:&[&str])->Value {
        let (id,version)=tag.rsplit_once("-v").unwrap();
        let mut assets=vec![json!({"name":"catalog.json","browser_download_url":format!("{PREFIX}{tag}/catalog.json")})];
        assets.extend(targets.iter().map(|target|json!({"name":format!("{id}-{version}-{target}.fhplugin")})));
        json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":assets,"body":"<script>plain text</script>"})
    }
    #[test]
    fn latest_compatible_stable_release_uses_semver_and_keeps_intel_fallback(){
        let mut preview=release("machines-v9.0.0-beta.1",&["macos-aarch64"]);preview["prerelease"]=json!(true);
        let releases=json!([release("machines-v0.3.0",&["macos-aarch64","macos-x86_64"]),release("machines-v0.10.0",&["macos-aarch64"]),release("machines-v0.9.0",&["macos-aarch64"]),preview,release("docker-v1.0.0",&["macos-aarch64"])]);
        let arm=select(&releases,"macos-aarch64").unwrap();assert_eq!(arm.len(),2);assert_eq!(arm[1].version.to_string(),"0.10.0");
        let intel=select(&releases,"macos-x86_64").unwrap();assert_eq!(intel.len(),1);assert_eq!(intel[0].version.to_string(),"0.3.0");
    }
    #[test]
    fn draft_foreign_catalog_and_unsafe_ids_are_not_official_releases(){
        let mut draft=release("machines-v1.0.0",&["macos-aarch64"]);draft["draft"]=json!(true);
        let mut foreign=release("docker-v1.0.0",&["macos-aarch64"]);foreign["assets"][0]["browser_download_url"]=json!("https://example.test/catalog.json");
        assert!(select(&json!([draft,foreign,release("../escape-v1.0.0",&["macos-aarch64"])]),"macos-aarch64").unwrap().is_empty());
        assert!(select(&json!({}),"macos-aarch64").is_err());
    }
    #[test]
    fn history_is_plugin_and_target_scoped_sorted_and_bounded(){
        let target="macos-aarch64";
        let mut rows:Vec<_>=(1..=8).map(|minor|release(&format!("machines-v0.{minor}.0"),&[target])).collect();
        rows.push(release("machines-v1.0.0",&["macos-x86_64"]));
        rows.push(release("machines-v0.8.0",&[target]));
        rows.push(release("docker-v2.0.0",&[target]));
        let result=history_for(&rows,"machines",target);
        assert_eq!(result.len(),5);
        assert_eq!(result[0]["version"],"0.8.0");
        assert_eq!(result[0]["releaseNotes"],"<script>plain text</script>");
        assert_eq!(result[4]["version"],"0.4.0");
        assert!(history_for(&rows,"unlisted",target).is_empty());
    }
    #[tokio::test(start_paused = true)]
    async fn checks_catalogs_in_parallel_and_keeps_successes_on_timeout() {
        let target="macos-aarch64";
        let rows=json!((0..10).map(|i|release(&format!("fixture-{i}-v1.0.0"),&[target])).collect::<Vec<_>>());
        let selected=select(&rows,target).unwrap();
        let source=Source{id:"test".into(),name:"Official".into(),kind:"https".into(),location:INDEX.into(),key:KEY.into()};
        let start=Instant::now();
        let outcomes=read_catalogs(selected,|release| {
            let source=&source;
            async move {
                if release.id!="fixture-4" { return std::future::pending().await; }
                tokio::time::sleep(Duration::from_secs(1)).await;
                let manifest=serde_json::from_value(json!({
                    "schema":2,"id":release.id,"name":"Fixture","version":"1.0.0",
                    "ui":"ui/index.html","executable":"bin/run","permissions":["native-process"]
                })).unwrap();
                Ok(candidate(source,manifest,None))
            }
        }).await;
        assert_eq!(start.elapsed(),CATALOG_TOTAL_TIMEOUT);
        assert_eq!(outcomes.len(),10);
        assert!(outcomes[4].1.is_ok(),"a queued healthy catalog should begin after the first batch times out");
        assert!(outcomes[9].1.as_ref().is_err_and(|reason|reason.contains("检查超时")));
        assert_eq!(outcomes.iter().filter(|(_,result)|result.is_ok()).count(),1);
    }
    #[tokio::test]
    #[ignore = "read-only public registry smoke test; requires GitHub network access"]
    async fn public_official_catalog_is_compatible_with_native_scanning(){
        let source=Source{id:"public-smoke".into(),name:"Official".into(),kind:"https".into(),location:INDEX.into(),key:format!("untrusted comment: public key\n{KEY}\n")};
        let (plugins,warnings)=scan(&source).await.unwrap();
        assert!(warnings.is_empty(),"{}",warnings.join("\n"));
        assert!(plugins.iter().any(|plugin|plugin.manifest.id=="machines"));
        for plugin in plugins {assert_eq!(plugin.source,"public-smoke");assert_eq!(plugin.target,format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH));assert!(!plugin.signature.is_empty());assert_eq!(plugin.sha256.len(),64);}
    }
}
