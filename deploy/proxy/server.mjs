import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {Box} from '@upstash/box';
import WebSocket,{WebSocketServer} from 'ws';
import {Lifecycle} from './lifecycle.mjs';
import {Broker} from './broker.mjs';
const port=Number(process.env.PORT||3000);
const stateDir=process.env.PROXY_STATE_DIR||'/data';
const brokers=new Set();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(stateDir,{recursive:true});
if(!process.env.CHISEL_AUTH||!process.env.BOX_ID)throw Error('Missing proxy configuration');
await writeFile(stateDir+'/chisel-users.json',JSON.stringify({[process.env.CHISEL_AUTH]:['^R:127\\.0\\.0\\.1:477[34]$']}),{mode:0o600});
const tunnel=spawn('chisel',['server','--host','127.0.0.1','--port','8081','--reverse','--keepalive','25s','--authfile',stateDir+'/chisel-users.json'],{env:{...process.env,AUTH:undefined},stdio:['ignore','ignore','inherit']});
tunnel.on('exit',()=>process.exit(1));
const box=await Box.get(process.env.BOX_ID,{timeout:120000,enableTelemetry:false});
if(box.keepAlive)throw Error('Proxy requires a Box with keepAlive disabled');
async function ready(){
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){try{
    const r=await fetch('http://127.0.0.1:4773/.well-known/t3/environment',{signal:AbortSignal.timeout(3000)});
    if(r.ok)return;
  }catch{}await delay(1000);}
  throw Error('Tunnel startup timed out');
}
const life=new Lifecycle({box,stateFile:stateDir+'/state.json',idleMs:Number(process.env.IDLE_MS||3600000),ready,onSleep:async()=>{for(const b of brokers)b.detach();}});
await life.load();
// Restart must not call resume on an idle Box. Reconcile existing running state.
const existing=await box.getStatus();
life.awake=/running/i.test(existing.status);
if(life.awake&&!life.lastUserAt){life.lastUserAt=Date.now();await life.save();}
setInterval(()=>life.idle().catch(()=>console.error('idle_pause_failed')),10000).unref();
const metadata=new Map();
const allowedInitial=pathname=>pathname==='/'||pathname==='/pair'||pathname.startsWith('/oauth/')||pathname.startsWith('/api/auth/');
async function ensureHTTP(req,path){
  if(life.awake)return;
  // Existing WS clients wake from their new operation; background HTTP stays asleep.
  if(brokers.size>0)throw Error('Box is asleep; waiting for an operation');
  if(allowedInitial(path)||path==='/.well-known/t3/environment')await life.userActivity();
  else throw Error('Open the T3 root page to connect');
}
function headers(req){
  const h={...req.headers,host:'127.0.0.1:3773'};
  delete h.connection;delete h['proxy-authorization'];delete h['proxy-connection'];
  // Preserve the external address for auth/redirects, including DPoP.
  h['x-forwarded-host']=req.headers.host;h['x-forwarded-proto']='https';
  return h;
}
function error(res,code,message){if(!res.headersSent)res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:message}));}
const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/__proxy/admin/sleep'){
    if(req.method!=='POST'||!process.env.PROXY_ADMIN_TOKEN||req.headers.authorization!=='Bearer '+process.env.PROXY_ADMIN_TOKEN){res.writeHead(403).end();return;}
    try {life.lastUserAt=Date.now()-life.idleMs-1;await life.save();await life.idle();res.writeHead(200).end('paused');}
    catch {error(res,503,'Pause failed');}return;
  }
  if(path==='/healthz'){res.writeHead(200).end('ok');return;}
  // No credentials or paths to private APIs in status output.
  if(path==='/__proxy/status'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({awake:life.awake,clients:brokers.size,lastActivity:life.lastUserAt,idleMs:life.idleMs}));return;}
  try{
    if(!life.awake&&metadata.has(req.url)){const c=metadata.get(req.url);res.writeHead(200,c.headers).end(c.body);return;}
    await ensureHTTP(req,path);
    const upstream=http.request({hostname:'127.0.0.1',port:4773,path:req.url,method:req.method,headers:headers(req)},out=>{
      const h={...out.headers};delete h['transfer-encoding'];
      if(h.location?.startsWith('http://127.0.0.1:3773'))h.location=h.location.replace('http://127.0.0.1:3773','https://'+req.headers.host);
      if(path==='/.well-known/t3/environment'&&out.statusCode===200){
        const chunks=[];out.on('data',c=>chunks.push(c));out.on('end',()=>{const body=Buffer.concat(chunks);metadata.set(req.url,{headers:h,body});res.writeHead(200,h).end(body);});
      }else{res.writeHead(out.statusCode,h);out.pipe(res);}
    });
    upstream.setTimeout(120000,()=>upstream.destroy());
    upstream.on('error',()=>error(res,503,'Box tunnel unavailable; reconnect shortly'));
    req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  }catch {error(res,503,'Box asleep or waking; waiting for an operation');}
});
function connect(path,h){return new Promise((resolve,reject)=>{
  const clean={...h,host:'127.0.0.1:3773'};
  for(const key of ['sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol','connection','upgrade'])delete clean[key];
  const ws=new WebSocket('ws://127.0.0.1:4773'+path,{headers:clean,handshakeTimeout:15000,maxPayload:8*1024*1024,perMessageDeflate:false});
  ws.once('open',()=>resolve(ws));ws.once('error',reject);
  ws.once('unexpected-response',(_req,r)=>{r.resume();ws.terminate();reject(Error('T3 authentication rejected'));});
});}
async function renew(ticket){
  const r=await fetch('http://127.0.0.1:4774/renew',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('Ticket renewal rejected');return (await r.json()).ticket;
}
const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
server.on('upgrade',async(req,socket,head)=>{
  socket.on('error',()=>{});
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/__chisel'){
    const raw=net.connect(8081,'127.0.0.1',()=>{
      raw.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries(req.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
      if(head.length)raw.write(head);socket.pipe(raw).pipe(socket);
    });raw.on('error',()=>socket.destroy());socket.on('close',()=>raw.destroy());return;
  }
  if(path!=='/ws'){socket.end('HTTP/1.1 404 Not Found\r\n\r\n');return;}
  if(brokers.size>=32){socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return;}
  try{
    if(!life.awake)await life.userActivity();
    const up=await connect(req.url,headers(req));
    wss.handleUpgrade(req,socket,head,client=>{
      const b=new Broker({client,upstream:up,request:req,life,renew,connect});brokers.add(b);
      client.on('close',()=>brokers.delete(b));
    });
  }catch {socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');}
});
// Transport pings stay between client and Railway and never call Box APIs.
setInterval(()=>{for(const client of wss.clients)if(client.readyState===WebSocket.OPEN)client.ping();},25000).unref();
server.listen(port,'0.0.0.0',()=>console.log('proxy_listening'));
process.on('SIGTERM',()=>{for(const b of brokers)b.client.close(1012,'Proxy restarting');tunnel.kill();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref();});
