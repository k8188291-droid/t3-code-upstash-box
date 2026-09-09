import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activity,subscription} from './protocol.mjs';
import {Lifecycle} from './lifecycle.mjs';
import {Broker} from './broker.mjs';
import {EventEmitter} from 'node:events';
test('transport pings, polling and subscriptions never count as activity',()=>{
 for(const m of [{_tag:'Ping'},{_tag:'Pong'},{_tag:'Request',tag:'server.getHostResources'}, {_tag:'Request',tag:'subscribeResourceTelemetry'},{_tag:'Request',tag:'server.reportClientActivity',payload:{recentlyInteracted:false}}])assert.equal(activity(m),false);
 assert.equal(activity({_tag:'Request',tag:'terminal.write'}),true);
 assert.equal(activity({_tag:'Request',tag:'orchestration.dispatchCommand'}),true);
 assert.equal(subscription({_tag:'Request',tag:'orchestration.subscribeShell'}),true);
});
test('activity coalesces wakes, throttles date, idle pauses once',async()=>{
 let now=1000;const calls=[];
 const box={resume:async()=>calls.push('resume'),pause:async()=>calls.push('pause'),exec:{command:async c=>{calls.push(c);return {exitCode:0};}}};
 const l=new Lifecycle({box,now:()=>now,idleMs:100,touchMs:30});
 await Promise.all([l.userActivity(),l.userActivity()]);assert.equal(calls.filter(c=>c==='resume').length,1);
 now+=40;await l.userActivity();assert.equal(calls.filter(c=>c==='date').length,1);
 now+=90;await l.idle();assert.equal(l.awake,true);
 now+=11;await l.idle();await l.idle();assert.equal(calls.filter(c=>c==='pause').length,1);
});
class Socket extends EventEmitter{readyState=1;bufferedAmount=0;sent=[];send(s){this.sent.push(JSON.parse(s));}terminate(){this.readyState=3;this.emit('close');}close(){this.terminate();}}
test('sleep preserves client; heartbeat does not wake; new request reconnects exactly once',async()=>{
 const client=new Socket(),up=new Socket(),next=new Socket();let wakes=0,renews=0;
 const b=new Broker({client,upstream:up,request:{url:'/ws?wsTicket=ticket',headers:{}},life:{userActivity:async()=>wakes++},renew:async()=>{renews++;return 'new';},connect:async()=>next});
 await b.receive(Buffer.from(JSON.stringify({_tag:'Request',id:'s',tag:'subscribeServerConfig',payload:{}})));
 await b.receive(Buffer.from(JSON.stringify({_tag:'Request',id:'old',tag:'terminal.write',payload:{data:'old'}})));
 b.detach();assert.equal(client.readyState,1);assert.ok(client.sent.some(m=>m.requestId==='old'&&m.exit._tag==='Failure'));
 wakes=0;await b.receive(Buffer.from('{"_tag":"Ping"}'));assert.equal(wakes,0);assert.equal(client.sent.at(-1)._tag,'Pong');
 await b.receive(Buffer.from(JSON.stringify({_tag:'Request',id:'new',tag:'terminal.write',payload:{data:'new'}})));
 assert.equal(wakes,1);assert.equal(renews,1);assert.equal(next.sent.filter(m=>m.id==='new').length,1);
 assert.equal(next.sent.filter(m=>m.id==='old').length,0);assert.equal(next.sent.filter(m=>m.id==='s').length,1);
});
