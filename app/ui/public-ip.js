// Both address families settle independently; a missing IPv6 route cannot hide IPv4.
window.FlowHubLookupPublicIp = async function(onProgress = () => {}) {
  const result = { pending: ['ipv4', 'ipv6'], errors: {} };
  await Promise.all(['ipv4', 'ipv6'].map(async family => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`https://${family === 'ipv4' ? 'api4' : 'api6'}.ipify.org?format=json`, {cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const body = await response.json();
      const address = String(body.ip || '');
      const valid = family === 'ipv4' ? /^(\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(n => +n <= 255) : address.includes(':') && /^[0-9a-f:]+$/i.test(address);
      if (!valid) throw new Error('地址响应无效');
      result[family] = address;
    } catch (error) {
      result.errors[family] = error.name === 'AbortError' ? '查询超时，请重试' : '查询失败，请检查网络或该协议的连通性';
    } finally {
      clearTimeout(timeout);
      result.pending = result.pending.filter(value => value !== family);
      onProgress({...result, errors:{...result.errors}, pending:[...result.pending]});
    }
  }));
  return result;
};
