// Run from repository root: node --env-file=.env deploy/proxy/setup-box.mjs
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Box} from '@upstash/box';
const cfg=JSON.parse(await readFile(new URL('../../.env.proxy.json',import.meta.url),'utf8'));
const box=await Box.get(cfg.boxId,{timeout:120000,enableTelemetry:false});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const run=async command=>{const r=await box.exec.command(command);if(r.exitCode!==0)throw Error('Box setup command failed');return r.stdout;};
await box.resume();
await run('mkdir -p /workspace/home/proxy-box && chmod 700 /workspace/home/proxy-box');
const arch=(await run('uname -m')).trim();
const platform={aarch64:'arm64',x86_64:'amd64'}[arch];if(!platform)throw Error('Unsupported architecture');
await run(`cd /workspace/home/proxy-box && curl -fsSL https://github.com/jpillora/chisel/releases/download/v1.12.0/chisel_1.12.0_linux_${platform}.gz -o chisel-new.gz && gzip -df chisel-new.gz && chmod 700 chisel-new && mv chisel-new chisel`);
const dir=await mkdtemp(join(tmpdir(),'t3-tunnel-'));
try{
 const path=join(dir,'tunnel.env');
 await writeFile(path,`AUTH=${quote(cfg.chiselAuth)}\nPROXY_TUNNEL_URL=${quote(cfg.domain+'/__chisel')}\n`,{mode:0o600});
 await box.files.upload([
  {path:new URL('./box-control.mjs',import.meta.url).pathname,destination:'/workspace/home/proxy-box/box-control.mjs'},
  {path:new URL('./box-start.sh',import.meta.url).pathname,destination:'/workspace/home/proxy-box/start.sh'},
  {path,destination:'/workspace/home/proxy-box/tunnel.env'},
 ]);
 await run('chmod 600 /workspace/home/proxy-box/tunnel.env');
 await run("pkill -f '^node /workspace/home/proxy-box/box-control.mjs$' || true");
 await run('bash /workspace/home/proxy-box/start.sh');
 console.log('Box tunnel configured:',cfg.boxId);
}finally{await rm(dir,{recursive:true,force:true});}
