import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,randomBytes} from 'node:crypto'
import http from 'node:http'
import {once} from 'node:events'
import {Ledger,CALL_DEBIT} from '../services/model-gateway/ledger.mjs'
import {createGateway} from '../services/model-gateway/server.mjs'
import {Vault} from '../packages/credentials/vault.mjs'
const body={model:'deepseek-flash',stream:true,max_tokens:32,thinking:{type:'disabled'},messages:[{role:'user',content:[{type:'text',text:'Reply OK'}]}]}
const cap='a'.repeat(64),fakeKey='sk-'+'x'.repeat(32)
const events=[
 {type:'message_start',message:{usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:5}}},
 {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
 {type:'message_stop'},
]
function stream(list=events){
 const bytes=Buffer.from(list.map(x=>'event: '+x.type+'\r\ndata: '+JSON.stringify(x)+'\r\n\r\n').join(''))
 let offset=0
 return new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return}c.enqueue(bytes.subarray(offset,offset+3));offset=Math.min(offset+3,bytes.length)}}),{headers:{'Content-Type':'text/event-stream'}})
}
async function fixture(t,provider){
 const dir=mkdtempSync(join(tmpdir(),'vibe-gateway-test-')),ledger=new Ledger(join(dir,'db.sqlite')),socket=join(dir,'api.sock')
 let calls=0
 const server=createGateway({ledger,capability:cap,vault:{get(id){assert.ok(id>=20&&id<=27);return fakeKey},metadata(){return[{id:20}]}},fetchImpl:async(...args)=>{calls++;return provider?provider(...args):stream()}})
 server.listen(socket);await once(server,'listening')
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));ledger.close();rmSync(dir,{recursive:true,force:true})})
 async function request(data=body,headers={},method='POST',path='/v1/messages'){
  const raw=typeof data==='string'?data:JSON.stringify(data)
  return new Promise((resolve,reject)=>{
   const req=http.request({socketPath:socket,path,method,headers:{Authorization:'Bearer '+cap,'Content-Type':'application/json','X-Vibe-Credential':'20','X-Vibe-Request-Id':randomUUID(),...headers}},res=>{
    const parts=[];res.on('data',p=>parts.push(p));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(parts).toString()}))
   });req.on('error',reject);req.end(raw)
  })
 }
 return {ledger,request,calls:()=>calls,socket,dir}
}
test('Confirmed terminal usage settles its reserve; one million cap includes all cache and output tokens',()=>{
 const ledger=new Ledger(':memory:')
 for(let i=0;i<100;i++){const id=randomUUID();ledger.reserve(id,20+i%8,'h');ledger.finish(id,'settled',{input:10,output:2,cacheRead:5,cacheWrite:0,total:17},200)}
 assert.equal(ledger.status().debitedTokens,1700);assert.equal(ledger.status().confirmed_tokens,1700)
 assert.equal(ledger.status().remainingAuthorizationTokens,998300)
 ledger.close()
})
test('Fifteen outstanding or uncertain full envelopes are the maximum without trusted usage',()=>{
 const ledger=new Ledger(':memory:')
 for(let i=0;i<15;i++)ledger.reserve(randomUUID(),20+i%8,'h')
 assert.throws(()=>ledger.reserve(randomUUID(),27,'h'),/TOKEN_BUDGET_EXHAUSTED/)
 assert.equal(ledger.status().uncertain_ceiling,983040);ledger.close()
})
test('Large confirmed usage cannot admit calls beyond the unchanged million-token ceiling',()=>{
 const ledger=new Ledger(':memory:')
 for(let i=0;i<15;i++){const id=randomUUID();ledger.reserve(id,20+i%8,'h');ledger.finish(id,'settled',{input:CALL_DEBIT-2,output:2,cacheRead:0,cacheWrite:0,total:CALL_DEBIT},200)}
 assert.throws(()=>ledger.reserve(randomUUID(),27,'h'),/TOKEN_BUDGET_EXHAUSTED/)
 assert.equal(ledger.status().confirmed_tokens,983040);ledger.close()
})

test('Duplicate admission and duplicate settlement cannot trigger another call or debit',()=>{
 const l=new Ledger(':memory:'),id=randomUUID();l.reserve(id,20,'hash');assert.throws(()=>l.reserve(id,21,'other'),/REQUEST_ALREADY_ADMITTED/)
 l.finish(id,'settled',{input:10,output:2,cacheRead:0,cacheWrite:0,total:12},200)
 assert.throws(()=>l.finish(id,'settled',{input:10,output:2,cacheRead:0,cacheWrite:0,total:12},200),/CAS/)
 assert.equal(l.status().debitedTokens,12);l.close()
})
test('Interrupted sent request becomes uncertain on WAL reopen and retains the full debit',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vibe-ledger-')),p=join(dir,'db'),id=randomUUID()
 let l=new Ledger(p);l.reserve(id,27,'hash');l.close();l=new Ledger(p)
 assert.equal(l.status().uncertain_ceiling,CALL_DEBIT);assert.equal(l.status().attempts,1)
 assert.equal(l.db.prepare('SELECT state FROM model_requests').get().state,'uncertain');l.close();rmSync(dir,{recursive:true,force:true})
})
test('AES-GCM plaintext absent, AAD bound to credential number and corrupted ciphertext rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vibe-vault-')),master=randomBytes(32),v=new Vault(master,dir)
 v.put(20,fakeKey,process.getgid());assert.equal(v.get(20),fakeKey)
 assert.ok(!readFileSync(v.file(20),'utf8').includes(fakeKey))
 const raw=JSON.parse(readFileSync(v.file(20),'utf8'));raw.id=21;writeFileSync(v.file(21),JSON.stringify(raw))
 assert.throws(()=>v.get(21))
 raw.id=20;raw.tag=Buffer.alloc(16).toString('base64');writeFileSync(v.file(20),JSON.stringify(raw))
 assert.throws(()=>v.get(20));rmSync(dir,{recursive:true,force:true})
})
test('Unauthorized caller rejected before reserve and upstream',async t=>{
 const f=await fixture(t);const r=await f.request(body,{Authorization:'Bearer wrong'});assert.equal(r.status,403);assert.equal(f.calls(),0);assert.equal(f.ledger.status().attempts,0)
})
test('Image, unknown model, excessive output and thinking cannot spend tokens',async t=>{
 const f=await fixture(t)
 for(const x of [{...body,model:'deepseek-v4-pro'},{...body,max_tokens:2049},{...body,thinking:{type:'enabled'}},{...body,messages:[{role:'user',content:[{type:'image',source:{type:'url',url:'http://evil'}}]}]}]){
  assert.equal((await f.request(x)).status,400)
 }
 assert.equal(f.calls(),0)
})
test('Oversized body rejected before reserve',async t=>{
 const f=await fixture(t);const r=await f.request({...body,system:'x'.repeat(17000)});assert.equal(r.status,413);assert.equal(f.ledger.status().attempts,0)
})
test('Fragmented SSE with CRLF crosses chunk boundaries; terminal usage commits before completion',async t=>{
 const f=await fixture(t),r=await f.request();assert.equal(r.status,200);assert.match(r.text,/"type":"message_stop"/);assert.equal(f.ledger.status().confirmed_tokens,17)
 assert.equal(f.ledger.db.prepare('SELECT state FROM model_requests').get().state,'settled')
})
test('Same request id is sent upstream once',async t=>{
 const f=await fixture(t),id=randomUUID();await f.request(body,{'X-Vibe-Request-Id':id});const r=await f.request(body,{'X-Vibe-Request-Id':id})
 assert.match(r.text,/REQUEST_ALREADY_ADMITTED/);assert.equal(f.calls(),1)
})
test('Concurrent attempts across all keys reserve atomically before any provider finishes',async t=>{
 let release
 const gate=new Promise(resolve=>{release=resolve})
 const f=await fixture(t,async()=>{await gate;return stream()})
 const all=Promise.all(Array.from({length:24},(_,i)=>f.request(body,{'X-Vibe-Credential':String(20+i%8)})))
 await new Promise(r=>setTimeout(r,100))
 assert.equal(f.calls(),15);assert.equal(f.ledger.status().uncertain_ceiling,983040)
 release();const responses=await all
 assert.equal(responses.filter(r=>r.status===200).length,15);assert.equal(f.ledger.status().debitedTokens,255)
})

test('Provider HTTP auth errors are sanitized and full debit stays consumed',async t=>{
 const f=await fixture(t,()=>new Response(fakeKey,{status:401})),r=await f.request()
 assert.equal(r.status,502);assert.ok(!r.text.includes(fakeKey));assert.equal(f.ledger.status().uncertain_ceiling,CALL_DEBIT)
})
test('Missing terminal usage and in-band provider error cannot appear as success',async t=>{
 const f=await fixture(t,()=>stream(events.filter(e=>e.type!=='message_delta'))),r=await f.request()
 assert.match(r.text,/PROVIDER_USAGE_INVALID/);assert.ok(!r.text.includes('"type":"message_stop"'));assert.equal(f.ledger.status().uncertain_ceiling,CALL_DEBIT)
})
test('Client disconnect aborts upstream and preserves non-refundable debit',async t=>{
 let aborted
 const done=new Promise(resolve=>{aborted=resolve})
 const f=await fixture(t,(_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>{aborted();reject(new Error('aborted'))},{once:true})}))
 const req=http.request({socketPath:f.socket,path:'/v1/messages',method:'POST',headers:{Authorization:'Bearer '+cap,'Content-Type':'application/json','X-Vibe-Credential':'20','X-Vibe-Request-Id':randomUUID()}})
 req.on('error',()=>{});req.end(JSON.stringify(body))
 while(f.calls()===0)await new Promise(r=>setTimeout(r,5))
 req.destroy();await done;await new Promise(r=>setTimeout(r,10))
 assert.equal(f.ledger.status().uncertain_ceiling,CALL_DEBIT)
})

test('In-band provider error text never exposes credential material or final success',async t=>{
 const f=await fixture(t,()=>stream([...events.slice(0,2),{type:'error',error:{message:fakeKey}}])),r=await f.request()
 assert.match(r.text,/PROVIDER_STREAM_ERROR/);assert.ok(!r.text.includes(fakeKey));assert.ok(!r.text.includes('"type":"message_stop"'));assert.equal(f.ledger.status().uncertain_ceiling,CALL_DEBIT)
})
test('Credential outside 20 through 27 and arbitrary route cannot dispatch',async t=>{
 const f=await fixture(t)
 assert.equal((await f.request(body,{'X-Vibe-Credential':'19'})).status,403)
 assert.equal((await f.request(body,{},'POST','/v1/chat/completions')).status,404)
 assert.equal(f.calls(),0);assert.equal(f.ledger.status().attempts,0)
})

test('Malformed settlement never releases capacity, duplicate settlement cannot refund twice',()=>{
 const l=new Ledger(':memory:'),id=randomUUID();l.reserve(id,20,'h')
 assert.throws(()=>l.finish(id,'settled',undefined,200),/INVALID_STATE/)
 assert.throws(()=>l.finish(id,'settled',{input:10,output:1,cacheRead:0,cacheWrite:0,total:0},200),/INVALID_USAGE/)
 assert.equal(l.status().debitedTokens,CALL_DEBIT)
 l.finish(id,'uncertain',undefined,undefined);assert.equal(l.status().debitedTokens,CALL_DEBIT);l.close()
})
test('V1 migration keeps the original history, cap and unresolved reservations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vibe-v2-')),p=join(dir,'db')
 let l=new Ledger(p),a=randomUUID(),b=randomUUID();l.reserve(a,20,'a');l.finish(a,'settled',{input:10,output:2,cacheRead:0,cacheWrite:0,total:12},200);l.reserve(b,21,'b')
 l.db.exec('DROP TABLE budget_authorization;UPDATE token_budget SET debited_tokens=131072');l.close()
 l=new Ledger(p);assert.equal(l.status().generation,2);assert.equal(l.status().attempts,2);assert.equal(l.status().confirmed_tokens,12);assert.equal(l.status().uncertain_ceiling,CALL_DEBIT);assert.equal(l.status().legacyDebitedTokens,131072);assert.equal(l.status().limitTokens,1000000)
 l.close();rmSync(dir,{recursive:true,force:true})
})
test('Read-only private status while streaming cannot turn an active request into uncertain',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve})
 const f=await fixture(t,async()=>{await gate;return stream()}),inflight=f.request()
 while(f.calls()===0)await new Promise(r=>setTimeout(r,5))
 const s=await f.request('',{},'GET','/v1/status')
 assert.equal(s.status,200);assert.equal(f.ledger.db.prepare('SELECT state FROM model_requests').get().state,'sent')
 release();assert.equal((await inflight).status,200)
})
