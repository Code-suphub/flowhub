import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help')) {
  console.log('node scripts/package.mjs --base-url https://HOST/PATH/ --signature machines/package.json.minisig [--out dist]');
  process.exit(0);
}
try {
  const base = new URL(option('--base-url'));
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('base-url 必须是无凭据、查询参数和片段的 HTTPS 目录地址');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const bytes = await readFile(resolve(root, 'machines/package.json'));
  const pkg = JSON.parse(bytes);
  if (pkg.schema !== 1 || pkg.id !== 'machines' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('插件 ID、schema 或版本无效');
  if (bytes.length > 262144) throw new Error('插件包超过 256 KiB');
  const signaturePath = option('--signature');
  if (!signaturePath) throw new Error('必须提供 Minisign 签名文件，不能发布未签名的目录');
  const signature = await readFile(resolve(signaturePath));
  if (!signature.toString().startsWith('untrusted comment:') || !signature.toString().includes('trusted comment:')) throw new Error('签名文件格式无效');
  const relative = `packages/machines/${pkg.version}/package.json`;
  const output = resolve(option('--out') || resolve(root, 'dist'));
  const target = resolve(output, relative);
  await mkdir(dirname(target), { recursive: true });
  // Exact signed bytes are copied; never reserialize after signing.
  await writeFile(target, bytes);
  const registry = { schema: 1, packages: [{ id: pkg.id, url: new URL(relative, base).href, sha256: createHash('sha256').update(bytes).digest('hex'), signature: signature.toString('base64') }] };
  await writeFile(resolve(output, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
  console.log(JSON.stringify({ output, version: pkg.version, registryUrl: new URL('registry.json', base).href, note: '发布前请用 minisign -Vm 核验原始包和签名；客户端会再次验签。' }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
