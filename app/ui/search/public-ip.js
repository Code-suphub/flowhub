// Families settle independently. Each provider gets 3 seconds (6 seconds per family).
window.FlowHubLookupPublicIp = async function(onProgress = () => {}, {signal} = {}) {
  const result = { pending: ['ipv4', 'ipv6'], errors: {} };
  const cancelled = () => { const error = new Error('查询已取消'); error.name = 'AbortError'; return error; };
  await Promise.all(['ipv4', 'ipv6'].map(async family => {
    const version = family === 'ipv4' ? '4' : '6';
    const endpoints = [`https://api${version}.ipify.org?format=json`, `https://${version}.ident.me/`];
    try {
      for (const [index, endpoint] of endpoints.entries()) {
        if (signal?.aborted) throw cancelled();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, {once:true});
        const timeout = setTimeout(abort, 3000);
        try {
          const response = await fetch(endpoint, {cache:'no-store', signal:controller.signal});
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const address = String(index === 0 ? (await response.json()).ip || '' : await response.text()).trim();
          const valid = family === 'ipv4' ? /^(\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(n => +n <= 255) : address.includes(':') && /^[0-9a-f:]+$/i.test(address);
          if (!valid) throw new Error('地址响应无效');
          result[family] = address;
          break;
        } catch (error) {
          if (signal?.aborted) throw cancelled();
          if (index === endpoints.length - 1) throw error;
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      result.errors[family] = error.name === 'AbortError' ? '查询超时，请重试' : '查询失败，请检查网络或该协议的连通性';
    } finally {
      result.pending = result.pending.filter(value => value !== family);
      if (!signal?.aborted) onProgress({...result, errors:{...result.errors}, pending:[...result.pending]});
    }
  }));
  return result;
};
