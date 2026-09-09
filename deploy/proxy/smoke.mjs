// Pauses only the dedicated proxy Box.
import {readFile} from 'node:fs/promises';
import {Box} from '@upstash/box';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import {messages} from './protocol.mjs';
const cfg=JSON.parse(await readFile(new URL('../../.env.proxy.json',import.meta.url),'utf8'));
const box=await Box.get(cfg.boxId);
const pair=await box.exec.command('node /workspace/home/.local/share/t3-background/runtime/node_modules/t3/dist/bin.mjs pair');
const token=pair.stdout?.match(/^Token:\s*(\S+)/m)?.[1];assert.ok(token,'pair token');
const auth=await fetch(cfg.domain+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:token,subject_token_type:'urn:t3:params:oauth:token-type:environment-bootstrap',requested_token_type:'urn:ietf:params:oauth:token-type:access_token',client_label:'proxy smoke test'})});
assert.equal(auth.status,200,'token exchange');const {access_token}=await auth.json();
const tr=await fetch(cfg.domain+'/api/auth/websocket-ticket',{method:'POST',headers:{authorization:'Bearer '+access_token}});assert.equal(tr.status,200,'ticket request');
const {ticket}=await tr.json();
const ws=new WebSocket(cfg.domain.replace('https:','wss:')+'/ws?wsTicket='+encodeURIComponent(ticket));
let closed=false;ws.on('close',(code)=>{closed=true;console.log('socket_closed',code);});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
const results=new Map();let pong=0;
ws.on('message',d=>{for(const m of messages(d)){if(m._tag==='Pong')pong++;if(m._tag==='Exit')results.set(String(m.requestId),m.exit);}});
const send=(id,tag,payload={})=>ws.send(JSON.stringify({_tag:'Request',id,tag,payload,headers:[]}));
async function result(id){const end=Date.now()+150000;while(!results.has(id)){if(closed)throw Error('client connection lost');if(Date.now()>end)throw Error('RPC timeout '+id);await new Promise(r=>setTimeout(r,250));}const out=results.get(id);assert.equal(out._tag,'Success','RPC '+id+' success');return out;}
send('1','server.getConfig');await result('1');console.log('authenticated_rpc_ok');
send('stream','subscribeServerConfig');
const pause=await fetch(cfg.domain+'/__proxy/admin/sleep',{method:'POST',headers:{authorization:'Bearer '+cfg.adminToken}});assert.equal(pause.status,200,'pause');
for(let i=0;i<3;i++){ws.send(JSON.stringify({_tag:'Ping'}));await new Promise(r=>setTimeout(r,1000));}
assert.equal(closed,false,'downstream stays connected');assert.ok(pong>=3,'proxy handles pings');
const status=await box.getStatus();assert.match(status.status,/paus|stop|suspend/i,'Box still paused despite pings');console.log('paused_with_live_client_and_local_pongs');
send('wake','server.reportClientActivity',{clientId:'proxy-smoke',clientKind:'web',visible:true,focused:true,recentlyInteracted:true,scopes:[],observedAt:new Date().toISOString()});
await result('wake');send('2','server.getConfig');await result('2');assert.equal(closed,false);console.log('same_websocket_woke_box_and_resumed_rpc');
ws.close();
