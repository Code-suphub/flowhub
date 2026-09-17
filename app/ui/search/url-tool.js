(() => {
  let last = null, cached = null;
  const decode = text => { try { return decodeURIComponent(text); } catch { return null; } };
  function parse(query) {
    if (query.length > 65536) return null;
    const command = /^(urlencode|urldecode)\s+([\s\S]+)$/i.exec(query);
    if (command) {
      const encoding = command[1].toLowerCase() === 'urlencode';
      let value;
      try { value = encoding ? encodeURIComponent(command[2]) : decodeURIComponent(command[2]); }
      catch { return { mode: 'codec', error: encoding ? '文本包含无效的 Unicode 字符' : '编码无效，无法完整解码' }; }
      return { mode: 'codec', encoding, value };
    }
    const text = query.trim();
    if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return null;
    let url; try { url = new URL(text); } catch { return null; }
    const rows = [['协议',url.protocol.slice(0,-1)],['主机',url.hostname],['端口',url.port || (url.protocol==='https:'?'443（默认）':'80（默认）')],['路径',url.pathname]];
    const decodedPath = decode(url.pathname);
    if (decodedPath !== null && decodedPath !== url.pathname) rows.push(['路径（解码）',decodedPath]);
    if (url.search) rows.push(['原始查询',url.search.slice(1)]);
    for (const [key,value] of url.searchParams) rows.push([`参数 · ${key}`,value]);
    if (url.hash) rows.push(['片段',decode(url.hash.slice(1)) ?? url.hash.slice(1)]);
    return { mode:'url', original:text, rows };
  }
  function get(query) { if (query !== last) { last=query;cached=parse(query); } return cached; }
  const button = (action,label,extra='') => `<button type="button" class="tool-action" data-tool-id="url" data-tool-action="${action}" ${extra}>${label}</button>`;
  async function copy(ctx, action, target) {
    const value=get(ctx.queryNow());if(!value||value.error)return;
    let text;
    if (action==='value' && value.mode==='url') text=value.rows[Number(target?.dataset.part)]?.[1];
    else if (value.mode==='codec') text=value.value;
    else text=value.rows.map(([key,val])=>`${key}: ${val}`).join('\n');
    if (text===undefined)return;await ctx.copy(text);ctx.status('已复制');
  }
  window.FlowHubUrl = {parse};
  window.FlowHubTools.register({
    id:'url',
    queryChanged({active}) { if(!active){last=null;cached=null;} },
    suggestions(ctx) { return get(ctx.query)?[{id:'url:inspect',type:'url-tool',toolId:'url'}]:[]; },
    render(item,{esc,index,active}) {
      const v=cached;if(!v)return '';
      const title=v.mode==='url'?'URL 解析':v.encoding?'URL 组件编码':'URL 组件解码';
      const content=v.error?`<div class="port-detail" role="status">${esc(v.error)}</div>`:v.mode==='codec'
        ?`<pre class="network-output">${esc(v.value.slice(0,4000))}</pre>${v.value.length>4000?'<div class="port-detail">预览已截断，复制包含完整内容。</div>':''}${button('copy','复制结果')}`
        :`<table class="process-properties"><tbody>${v.rows.slice(0,20).map(([key,value],i)=>`<tr><th scope="row">${esc(key.slice(0,100))}</th><td>${esc(value.slice(0,500))}${value.length>500?'…':''}</td><td>${button('value','复制',`data-part="${i}"`)}</td></tr>`).join('')}</tbody></table>${v.rows.length>20?'<div class="port-detail">仅预览前 20 项，复制详情包含全部参数。</div>':''}${button('copy','复制解析详情')}`;
      return `<div class="result port-result ${active?'active':''}" data-i="${index}"><div class="r-body"><div class="r-title">${title}</div><div class="port-detail">本地处理 · 不发起网络请求 · 回车复制${v.mode==='codec'?' · 使用 URI 组件规则，+ 保持原样':''}</div>${content}</div></div>`;
    },
    choose(item,ctx){return copy(ctx,'copy');},
    action(action,target,ctx){if(action==='copy'||action==='value')return copy(ctx,action,target);}
  });
})();
