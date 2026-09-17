const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ui=path.resolve(__dirname,'../../ui');
const htmlFiles=fs.readdirSync(ui).filter(name=>name.endsWith('.html'));
assert.ok(htmlFiles.length>0,'ui/ 根目录下应有页面入口');
let checked=0;
for(const name of htmlFiles){
  const html=fs.readFileSync(path.join(ui,name),'utf8');
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
    const target=match[1];
    if(/^(https?:|#|data:|\.\.|\/)/.test(target))continue;
    checked++;
    assert.ok(fs.existsSync(path.join(ui,target)),`${name} 引用了不存在的资源：${target}`);
  }
}
assert.ok(checked>20,`解析到的本地资源引用过少（${checked} 处），检查正则或目录结构是否已变化`);
// 适配层用根绝对路径读取 /plugins.json，这个文件必须留在 ui 根目录。
assert.ok(fs.existsSync(path.join(ui,'plugins.json')),'plugins.json 必须留在 ui/ 根目录');
// 入口页文件名被 Rust 的 WebviewUrl / tauri.conf.json / desktop_security 直接引用。
for(const entry of ['search.html','settings.html','menu-bar-panel.html','plugin-canvas.html','plugin-detail.html','plugin-market.html','plugin-status.html']){
  assert.ok(fs.existsSync(path.join(ui,entry)),`入口页 ${entry} 必须留在 ui/ 根目录`);
}
console.log(`PASS: ${htmlFiles.length} 个入口页的 ${checked} 处资源引用均可解析，plugins.json 与入口页仍在 ui 根`);
