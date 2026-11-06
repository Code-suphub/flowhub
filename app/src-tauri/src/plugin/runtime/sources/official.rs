use super::*;
use std::collections::BTreeMap;

// GitHub's public Releases feed is the aggregate source; no separate registry
// service or publishing step is needed. Package trust still uses a pinned key.
pub(super) const INDEX:&str="https://api.github.com/repos/Code-suphub/flowhub-plugins/releases?per_page=100";
pub(super) const KEY:&str="RWQIJOnosHIl5QGJ83XSe/Mx8aIvANKnnSUDpzVVNxCAZjTR+cBm1Jne";
const PREFIX:&str="https://github.com/Code-suphub/flowhub-plugins/releases/download/";

#[derive(Clone)]
struct Release { id:String,version:semver::Version,catalog:String,notes:String,published:String }
fn select(releases:&Value,target:&str)->Result<Vec<Release>,String>{
    let rows=releases.as_array().ok_or("官方发布列表格式无效")?;
    let mut latest:BTreeMap<String,Release>=BTreeMap::new();
    for release in rows {
        if release["draft"]==true || release["prerelease"]==true {continue;}
        let Some(tag)=release["tag_name"].as_str() else{continue};
        let Some((id,version))=tag.rsplit_once("-v") else{continue};
        let Ok(version)=semver::Version::parse(version) else{continue};
        if !safe_id(id) || !version.pre.is_empty(){continue;}
        let Some(assets)=release["assets"].as_array() else{continue};
        let package_name=format!("{id}-{version}-{target}.fhplugin");
        if !assets.iter().any(|a|a["name"].as_str()==Some(&package_name)){continue;}
        let expected=format!("{PREFIX}{tag}/catalog.json");
        if !assets.iter().any(|a|a["name"]=="catalog.json" && a["browser_download_url"].as_str()==Some(&expected)){continue;}
        if latest.get(id).is_some_and(|old|old.version>=version){continue;}
        latest.insert(id.into(),Release{id:id.into(),version,catalog:expected,notes:release["body"].as_str().unwrap_or("").chars().take(20_000).collect(),published:release["published_at"].as_str().unwrap_or("").into()});
    }
    if latest.len()>100{return Err("官方插件数量超过读取上限".into());}
    Ok(latest.into_values().collect())
}
pub(super) async fn scan(source:&Source)->Result<(Vec<Candidate>,Vec<String>),String>{
    // A source with a different key must never gain the official identity.
    let bare=source.key.trim().lines().find(|line|!line.starts_with("untrusted comment:")).unwrap_or("");
    let key=minisign_verify::PublicKey::from_base64(bare).map_err(|_|"官方库公钥无效，请重新连接官方库")?;
    let pinned=minisign_verify::PublicKey::from_base64(KEY).unwrap();
    // Both native text and bare public-key forms are accepted by verification.
    if key!=pinned{return Err("官方库公钥与内置公钥不一致，请检查来源设置".into());}
    let target=format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH);
    let mut all=Vec::new();let mut bounded=false;
    for page in 1..=5 {
        let bytes=download(&format!("{INDEX}&page={page}"),4*1024*1024).await?;
        let list:Value=serde_json::from_slice(&bytes).map_err(|_|"官方发布列表格式无效")?;
        let rows=list.as_array().ok_or("官方发布列表格式无效")?;
        let count=rows.len();all.extend(rows.iter().cloned());
        if count<100 {break;}
        if page==5 {bounded=true;}
    }
    let selected=select(&json!(all),&target)?;
    let mut found=Vec::new();let mut warnings=Vec::new();
    if bounded{warnings.push("仅检查最近 500 个公开发布；更早的版本未读取。".into());}
    for release in selected {
        let result=async {
            let bytes=download(&release.catalog,2*1024*1024).await?;
            let catalog:Value=serde_json::from_slice(&bytes).map_err(|_|"插件目录格式无效")?;
            let (mut plugins,_)=parse_catalog(source,&catalog,&target)?;
            plugins.retain(|c|c.manifest.id==release.id && c.manifest.version==release.version.to_string());
            if plugins.len()!=1{return Err("发布版本与目录中的插件不一致".into());}
            let mut c=plugins.remove(0);
            let expected=format!("{PREFIX}{}-v{}/{}-{}-{target}.fhplugin",release.id,release.version,release.id,release.version);
            if c.url!=expected{return Err("官方安装包地址与发布版本不一致".into());}
            c.release_notes=release.notes;c.published_at=release.published;
            Ok::<_,String>(c)
        }.await;
        match result {Ok(c)=>found.push(c),Err(error)=>warnings.push(format!("{}：{error}",release.id))}
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
