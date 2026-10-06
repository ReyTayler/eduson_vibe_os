
import test from 'node:test';
import assert from 'node:assert/strict';
import {Ledger,INPUT_SAFETY_MARGIN} from '../services/model-gateway/ledger.mjs';
import {createGateway,MAX_OUTPUT,MODEL_IDLE_TIMEOUT_MS,validateBody} from '../services/model-gateway/server.mjs';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
const initial=Date.parse('2026-10-06T12:00:00Z'),reset=Date.parse('2026-10-11T20:59:00Z');
const body={model:'deepseek-flash',stream:true,max_tokens:1000000,thinking:{type:'disabled'},messages:[{role:'user',content:[{type:'text',text:'OK'}]}]};
const usage=n=>({input:n-1,output:1,cacheRead:0,cacheWrite:0,total:n});
function settled(ledger,tokens,student=1){const id=randomUUID();ledger.reserve(id,19+student,'history',tokens,student);ledger.finish(id,'settled',usage(tokens),200)}
function events(text='OK',output=2){
 const rows=[
  {type:'message_start',message:{id:'test',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:10,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:output}},
  {type:'message_stop'},
 ];return rows.map(row=>'event: '+row.type+'\ndata: '+JSON.stringify(row)+'\n\n').join('');
}
async function fixture(t,fetchImpl,extra={}){
 const ledger=new Ledger(':memory:',{clock:()=>initial}),capability=randomBytes(32).toString('hex'),studentCap=randomBytes(32).toString('hex');
 const server=createGateway({ledger,vault:{get:()=> 'offline-placeholder',metadata:()=>[]},capability,studentCapabilities:[{student:1,capability:studentCap}],fetchImpl,...extra});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));ledger.close()});
 const request=(value=body,path='/v1/messages')=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:value?'POST':'GET',headers:{Authorization:'Bearer '+studentCap,'X-Vibe-Credential':'20','X-Vibe-Request-Id':randomUUID(),'Content-Type':'application/json'}},res=>{
   const parts=[];res.on('data',p=>parts.push(p));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString()}))
  });req.on('error',reject);req.end(value?JSON.stringify(value):undefined);
 });
 return {ledger,request};
}
test('No fixed output ceiling in gateway validation; allocation is weekly budget and provider driven',()=>{
 assert.equal(MAX_OUTPUT,393216);assert.equal(MODEL_IDLE_TIMEOUT_MS,300000);
 for(const n of [65537,393216,1000000,2000000])assert.equal(validateBody({...body,max_tokens:n}).max_tokens,n);
 assert.throws(()=>validateBody({...body,max_tokens:Number.MAX_SAFE_INTEGER+1}),/MODEL_OR_OUTPUT_LIMIT/);
});
test('Output admission allows the complete provider maximum without a platform answer cap',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial}),id=randomUUID();
 const result=l.reserveOutput(id,20,'a',34000,1000000,1);
 assert.equal(result.maxTokens,393216);assert.equal(result.debit,427216);assert.equal(l.status(1).uncertain_ceiling,427216);l.close();
});
test('Residual quota below old 131072 floor remains usable and output shrinks atomically',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});settled(l,900000);
 assert.ok(l.status(1).maxRemainingCalls>0);
 const r=l.reserveOutput(randomUUID(),20,'a',33000,393216,1);
 assert.equal(r.maxTokens,67000);assert.equal(r.debit,100000);assert.equal(l.status(1).debitedTokens,1000000);
 assert.throws(()=>l.reserveOutput(randomUUID(),20,'b',33000,393216,1),/TOKEN_BUDGET_EXHAUSTED/);
 assert.equal(l.status(2).debitedTokens,0);l.close();
});
test('Adaptive reservations have no fixed 131072 minimum; a final small output fits the weekly remainder',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});settled(l,960000);
 const r=l.reserveOutput(randomUUID(),20,'a',33000,393216,1);assert.equal(r.maxTokens,7000);assert.equal(r.debit,40000);l.close();
});
test('Context capacity and discovered provider capacity are honoured independently of internal 64K',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 const a=l.reserveOutput(randomUUID(),20,'a',50000,1000000,1,500000,600000);
 assert.equal(a.maxTokens,500000);
 const b=l.reserveOutput(randomUUID(),21,'b',20000,1000000,2,500000,100000);
 assert.equal(b.maxTokens,80000);l.close();
});
test('Two simultaneous projects cannot overbook; the next output is resized using the latest reservation',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 const a=l.reserveOutput(randomUUID(),20,'a',40000,1000000,1),b=l.reserveOutput(randomUUID(),20,'b',40000,1000000,1),c=l.reserveOutput(randomUUID(),20,'c',40000,1000000,1);
 assert.equal(a.maxTokens,393216);assert.equal(b.maxTokens,393216);assert.equal(c.maxTokens,93568);
 assert.equal(l.status(1).debitedTokens,1000000);
 assert.throws(()=>l.reserveOutput(randomUUID(),20,'d',40000,1000000,1),/TOKEN_BUDGET_EXHAUSTED/);l.close();
});
test('Terminal usage refunds unused output allowance; unknown outcome keeps only its admitted weekly envelope',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial}),a=randomUUID(),b=randomUUID();
 l.reserveOutput(a,20,'a',34000,1000000,1);l.finish(a,'settled',{input:100,output:70000,cacheRead:20,cacheWrite:0,total:70120},200);
 const result=l.reserveOutput(b,20,'b',34000,1000000,1);l.finish(b,'uncertain');
 assert.equal(l.status(1).debitedTokens,70120+result.debit);assert.equal(l.status(1).confirmed_tokens,70120);l.close();
});
test('An adaptive response ending after Sunday reset charges its admission week only',()=>{
 let now=reset-1;const l=new Ledger(':memory:',{clock:()=>now}),id=randomUUID();
 const r=l.reserveOutput(id,20,'a',34000,1000000,1);now=reset;
 l.finish(id,'settled',{input:100,output:100000,cacheRead:0,cacheWrite:0,total:100100},200);
 assert.equal(r.periodStart,reset/1000-604800);assert.equal(l.status(1).debitedTokens,0);assert.equal(l.status(1).remainingAuthorizationTokens,1000000);l.close();
});
test('Output envelope validation and failed admission are atomic',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 for(const n of [0,-1,NaN,1.1])assert.throws(()=>l.reserveOutput(randomUUID(),20,'h',n,393216,1),/INVALID_RESERVATION/);
 assert.throws(()=>l.reserveOutput(randomUUID(),20,'h',1000000,393216,1),/TOKEN_BUDGET_EXHAUSTED/);
 assert.equal(l.status(1).attempts,0);l.close();
});
test('Gateway sends provider maximum and streams a response larger than prior result and frame ceilings',async t=>{
 let sent;const text='A'.repeat(9*1024*1024)+' COMPLETE_END';
 const f=await fixture(t,async(url,options)=>{sent=JSON.parse(options.body);return new Response(events(text,100000),{headers:{'Content-Type':'text/event-stream'}})});
 const r=await f.request();assert.equal(r.status,200);assert.equal(sent.max_tokens,393216);assert.equal(r.headers['x-vibe-max-output-tokens'],'393216');
 assert.ok(r.text.includes('COMPLETE_END'));assert.ok(r.text.length>9*1024*1024);assert.equal(f.ledger.status(1).confirmed_tokens,100010);
});
test('Provider discovery can raise output above 393216 without code or student profile changes',async t=>{
 let sent;const f=await fixture(t,async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-flash',context_window:1048576,max_output_tokens:500000}]});
  sent=JSON.parse(options.body);return new Response(events(),{headers:{'Content-Type':'text/event-stream'}});
 });
 assert.equal((await f.request(null,'/v1/models')).status,200);
 assert.equal((await f.request()).status,200);assert.equal(sent.max_tokens,500000);
});
test('Gateway dynamically fits an answer to a small remaining week rather than requiring its full configured maximum',async t=>{
 let sent;const f=await fixture(t,async(url,options)=>{sent=JSON.parse(options.body);return new Response(events(),{headers:{'Content-Type':'text/event-stream'}})});
 settled(f.ledger,900000);const rawBytes=Buffer.byteLength(JSON.stringify(body));const r=await f.request();
 assert.equal(r.status,200);assert.equal(sent.max_tokens,100000-rawBytes-INPUT_SAFETY_MARGIN);assert.ok(sent.max_tokens>65536);assert.equal(f.ledger.status(1).confirmed_tokens,900012);
});
test('Idle timeout is reset by provider traffic and imposes no total response deadline',async t=>{
 const wire=Buffer.from(events()),chunks=[wire.subarray(0,wire.indexOf('\n\n')+2),Buffer.from(': ping\n\n'),Buffer.from(': ping\n\n'),Buffer.from(': ping\n\n'),wire.subarray(wire.indexOf('\n\n')+2)];let i=0;
 const f=await fixture(t,async()=>new Response(new ReadableStream({async pull(c){await new Promise(r=>setTimeout(r,30));if(i<chunks.length)c.enqueue(chunks[i++]);else c.close()}}),{headers:{'Content-Type':'text/event-stream'}}),{idleTimeoutMs:100});
 const started=Date.now(),r=await f.request();assert.equal(r.status,200);assert.ok(Date.now()-started>100);assert.ok(r.text.includes('"type":"message_stop"'));assert.equal(f.ledger.status(1).confirmed_tokens,12);
});
test('A genuinely idle provider is aborted with its weekly reservation retained',async t=>{
 const f=await fixture(t,async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('Offline idle upstream')),{once:true})}),{idleTimeoutMs:30});
 const r=await f.request();assert.equal(r.status,502);assert.equal(f.ledger.status(1).attempts,1);assert.ok(f.ledger.status(1).uncertain_ceiling>393216);
});
