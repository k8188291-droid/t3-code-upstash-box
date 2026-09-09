// Runs only inside the Box, bound to loopback. Exposed only over authenticated Chisel.
// Renews a previously authenticated WS session's short-lived ticket; T3 checks
// session revocation, expiry and scopes again on every upstream connection.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
const keyPath=join(homedir(),'.t3/userdata/secrets/server-signing-key.bin');
createServer(async(req,res)=>{
  try {
    if(req.method!=='POST'||req.url!=='/renew') {res.writeHead(404).end();return;}
    let body=''; for await(const part of req){body+=part;if(body.length>16384)throw Error('size');}
    const {ticket}=JSON.parse(body); const [payload,signature,...extra]=ticket.split('.');
    if(extra.length) throw Error('token');
    const key=await readFile(keyPath);
    const expected=createHmac('sha256',key).update(payload).digest();
    const supplied=Buffer.from(signature,'base64url');
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw Error('signature');
    const claim=JSON.parse(Buffer.from(payload,'base64url'));
    if(claim.v!==1||typeof claim.sid!=='string'||claim.kind!=='websocket')throw Error('claims');
    const now=Date.now();
    const renewed=Buffer.from(JSON.stringify({v:1,kind:'websocket',sid:claim.sid,iat:now,exp:now+60000})).toString('base64url');
    const sig=createHmac('sha256',key).update(renewed).digest('base64url');
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({ticket:renewed+'.'+sig}));
  }catch {res.writeHead(403).end('Ticket renewal rejected');}
}).listen(3774,'127.0.0.1');
