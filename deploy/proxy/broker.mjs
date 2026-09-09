import WebSocket from 'ws';
import { messages, activity, subscription, cacheKey, failure } from './protocol.mjs';
export class Broker {
  constructor({client,upstream,request,life,renew,connect}) {
    Object.assign(this,{client,request,life,renew,connect});
    this.upstream=null; this.connecting=null; this.closed=false; this.subs=new Map();
    this.pending=new Map(); this.waiting=new Map(); this.cache=new Map();
    this.ticket=new URL(request.url,'http://localhost').searchParams.get('wsTicket');
    this.receiveChain=Promise.resolve(); this.queuedBytes=0;
    this.bind(upstream);
    client.on('message',(data,binary)=>{
      if(binary){client.close(1003,'JSON RPC required');return;}
      try { if(messages(data).every(m=>m._tag==='Ping'||m._tag==='Pong')) {
        for(const m of messages(data))if(m._tag==='Ping')this.send({_tag:'Pong'});return;
      }}catch{client.close(1002,'Invalid JSON');return;}
      this.queuedBytes+=data.length;
      if(this.queuedBytes>4*1024*1024){client.close(1013,'Request queue full');return;}
      this.receiveChain=this.receiveChain.then(()=>this.closed?undefined:this.receive(data))
        .catch(()=>client.close(1011,'Proxy processing failed')).finally(()=>{this.queuedBytes-=data.length;});
    });
    client.on('close',()=>{this.closed=true;this.upstream?.terminate();this.pending.clear();this.waiting.clear();this.subs.clear();this.cache.clear();});
    client.on('error',()=>{});
  }
  send(m) { if(this.client.readyState===WebSocket.OPEN){if(this.client.bufferedAmount>8*1024*1024){this.client.close(1013,'Slow client');return;}this.client.send(JSON.stringify(m));} }
  bind(ws) {
    this.upstream=ws;
    ws.on('message',data=>{
      if(this.upstream!==ws)return;
      try {for(const m of messages(data)) {
        if(m._tag==='Ping'){ws.send(JSON.stringify({_tag:'Pong'}));continue;}
        if(m._tag==='Pong')continue;
        const id=String(m.requestId);
        if(m._tag==='Exit') {
          const sent=this.pending.get(id);
          if(sent&&m.exit?._tag==='Success'&&!activity(sent)) {
            if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value);
            if(JSON.stringify(m).length<128*1024)this.cache.set(cacheKey(sent),m);
          }
          this.pending.delete(id);this.subs.delete(id);
        }
        this.send(m);
      }} catch {this.client.close(1002,'Unexpected upstream protocol');}
    });
    ws.on('close',()=>{if(this.upstream===ws)this.detach();});
    ws.on('error',()=>{});
  }
  detach() {
    const ws=this.upstream;this.upstream=null;ws?.terminate();
    for(const [id,m] of this.pending){
      if(!this.subs.has(id))this.send(failure(m.id,'Upstream disconnected; execution outcome unknown. Request was NOT retried.'));
    }
    this.pending.clear();
  }
  async resume() {
    if(this.upstream?.readyState===WebSocket.OPEN)return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      if(!this.ticket)throw Error('A T3 wsTicket is required for reconnection');
      await this.life.ready?.();
      const ticket=await this.renew(this.ticket);
      const url=new URL(this.request.url,'http://localhost');url.searchParams.set('wsTicket',ticket);
      const ws=await this.connect(url.pathname+url.search,this.request.headers);
      if(this.closed){ws.terminate();return;}
      this.bind(ws);
      for(const m of this.subs.values()){ws.send(JSON.stringify(m));this.pending.set(String(m.id),m);}
      for(const m of this.waiting.values()){ws.send(JSON.stringify(m));this.pending.set(String(m.id),m);}
      this.waiting.clear();
    })().catch(error=>{
      // Revoked/expired sessions must authenticate again; never bypass T3 auth.
      this.client.close(1011,'Unable to resume authenticated T3 session');throw error;
    }).finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async receive(data) {
    if(data.length>1024*1024)throw Error('RPC message too large');
    for(const m of messages(data)){
      if(m._tag==='Ping'){this.send({_tag:'Pong'});continue;}
      if(m._tag==='Pong')continue;
      if(m._tag==='Interrupt'){
        const id=String(m.requestId);this.subs.delete(id);this.waiting.delete(id);this.pending.delete(id);
      }
      if(m._tag!=='Request'){
        if(this.upstream?.readyState===WebSocket.OPEN)this.upstream.send(JSON.stringify(m));
        continue;
      }
      const id=String(m.id);
      if(this.pending.has(id)||this.waiting.has(id)||this.subs.has(id)){this.send(failure(m.id,'Duplicate pending request ID'));continue;}
      if(this.pending.size+this.waiting.size+this.subs.size>=128){this.send(failure(m.id,'Too many pending requests'));continue;}
      if(activity(m)) {
        await this.life.userActivity();await this.resume();
      }
      if(subscription(m))this.subs.set(id,m);
      if(this.upstream?.readyState===WebSocket.OPEN){
        this.pending.set(id,m);this.upstream.send(JSON.stringify(m));
      }else if(m.tag==='server.reportClientActivity'||m.tag==='server.reportHostPowerState'){
        this.send({_tag:'Exit',requestId:m.id,exit:{_tag:'Success'}});
      }else {
        const cached=this.cache.get(cacheKey(m));
        if(cached){this.send({...cached,requestId:m.id});continue;}
        if(this.waiting.size>=128||this.subs.size>128){this.send(failure(m.id,'Box asleep; too many queued requests'));continue;}
        if(!subscription(m))this.waiting.set(id,m);
      }
    }
  }
}
