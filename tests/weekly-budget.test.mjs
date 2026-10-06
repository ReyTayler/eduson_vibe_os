
import test from 'node:test';
import assert from 'node:assert/strict';
import {Ledger,LegacyLedger,CALL_DEBIT,weekWindow} from '../services/model-gateway/ledger.mjs';
import {createGateway} from '../services/model-gateway/server.mjs';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
const initial=Date.parse('2026-10-06T12:00:00Z'),reset=Date.parse('2026-10-11T20:59:00Z');
const usage={input:10,output:2,cacheRead:5,cacheWrite:0,total:17};
const full=id=>({input:id-2,output:2,cacheRead:0,cacheWrite:0,total:id});
test('Sunday 23:59:00 Moscow is the exact boundary, independent of UTC host day',()=>{
 const a=weekWindow(reset-1),b=weekWindow(reset);
 assert.equal(new Date(a.end*1000).toISOString(),'2026-10-11T20:59:00.000Z');
 assert.equal(b.start,reset/1000);assert.equal(b.end-b.start,604800);
 assert.equal(weekWindow(initial).start,Date.parse('2026-10-04T20:59:00Z')/1000);
 assert.equal(weekWindow(Date.parse('2026-10-11T21:00:00Z')).start,b.start);
});
test('All five users each have an independent million; combined admission may exceed one million',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 for(let student=1;student<=5;student++)for(let i=0;i<7;i++)l.reserve(randomUUID(),19+student,'h',CALL_DEBIT,student);
 for(let student=1;student<=5;student++){
  assert.equal(l.status(student).uncertain_ceiling,917504);assert.equal(l.status(student).limitTokens,1000000);
  assert.throws(()=>l.reserve(randomUUID(),19+student,'h',CALL_DEBIT,student),/TOKEN_BUDGET_EXHAUSTED/);
 }
 assert.equal(l.overview().lifetime.uncertain_ceiling,4587520);l.close();
});
test('One exhausted user does not consume another quota or the operator test allowance',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 for(let i=0;i<7;i++)l.reserve(randomUUID(),20,'a',CALL_DEBIT,1);
 l.reserve(randomUUID(),21,'b',CALL_DEBIT,2);l.reserve(randomUUID(),25,'op');
 assert.equal(l.status(2).debitedTokens,CALL_DEBIT);assert.equal(l.status(3).remainingAuthorizationTokens,1000000);
 assert.equal(l.status().debitedTokens,CALL_DEBIT);l.close();
});
test('A fresh week is available exactly at reset, and unused tokens never accumulate',()=>{
 let now=reset-1;const l=new Ledger(':memory:',{clock:()=>now});
 l.reserve(randomUUID(),20,'a',1000000,1);
 assert.equal(l.status(1).maxRemainingCalls,0);
 now=reset;assert.equal(l.status(1).remainingAuthorizationTokens,1000000);
 l.reserve(randomUUID(),20,'new',CALL_DEBIT,1);
 assert.equal(l.status(1).remainingAuthorizationTokens,1000000-CALL_DEBIT);
 now+=604800000;assert.equal(l.status(1).remainingAuthorizationTokens,1000000);l.close();
});
test('Late completion settles its original week and leaves the new week untouched',()=>{
 let now=reset-1;const l=new Ledger(':memory:',{clock:()=>now}),oldId=randomUUID();
 const old=weekWindow(now).start;l.reserve(oldId,20,'old',CALL_DEBIT,1);
 now=reset;l.reserve(randomUUID(),20,'new',CALL_DEBIT,1);
 l.finish(oldId,'settled',usage,200);
 assert.equal(l.totals(1,old).confirmed_tokens,17);assert.equal(l.status(1).debitedTokens,CALL_DEBIT);l.close();
});
test('Cancel, provider failure and uncertain old calls stay in their admitted week',()=>{
 let now=reset-1;const l=new Ledger(':memory:',{clock:()=>now}),ids=[randomUUID(),randomUUID()];
 const old=weekWindow(now).start;for(const id of ids)l.reserve(id,20,'old',CALL_DEBIT,1);
 now=reset;l.finish(ids[0],'failed',undefined,500);l.finish(ids[1],'uncertain');
 assert.equal(l.totals(1,old).uncertain_ceiling,2*CALL_DEBIT);assert.equal(l.status(1).remainingAuthorizationTokens,1000000);l.close();
});
test('Global request id prevents duplicate billing or replay across reset or across users',()=>{
 let now=reset-1;const l=new Ledger(':memory:',{clock:()=>now}),id=randomUUID();
 l.reserve(id,20,'a',CALL_DEBIT,1);l.finish(id,'settled',usage,200);now=reset;
 assert.throws(()=>l.reserve(id,21,'b',CALL_DEBIT,2),/REQUEST_ALREADY_ADMITTED/);
 assert.equal(l.status(2).debitedTokens,0);assert.throws(()=>l.finish(id,'settled',usage,200),/CAS/);l.close();
});
test('Restart preserves weekly ownership, confirmed spend and full unresolved reservations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vibe-weekly-')),p=join(dir,'db');let now=initial;
 let l=new Ledger(p,{clock:()=>now}),a=randomUUID(),b=randomUUID();
 l.reserve(a,20,'a',CALL_DEBIT,1);l.finish(a,'settled',usage,200);l.reserve(b,21,'b',CALL_DEBIT,2);l.close();
 l=new Ledger(p,{clock:()=>now});
 assert.equal(l.status(1).confirmed_tokens,17);assert.equal(l.status(2).uncertain_ceiling,CALL_DEBIT);
 assert.equal(l.db.prepare('SELECT state FROM model_requests WHERE id=?').get(b).state,'uncertain');
 now=reset;assert.equal(l.status(2).remainingAuthorizationTokens,1000000);l.close();rmSync(dir,{recursive:true,force:true});
});
test('Clock rollback cannot reopen a previous week after a new period was admitted',()=>{
 let now=reset;const l=new Ledger(':memory:',{clock:()=>now});l.reserve(randomUUID(),20,'new',CALL_DEBIT,1);
 now=reset-1;assert.equal(l.status(1).enabled,false);assert.throws(()=>l.reserve(randomUUID(),20,'old',CALL_DEBIT,1),/CLOCK_ROLLBACK/);
 now=reset;assert.equal(l.status(1).enabled,true);l.close();
});
test('Legacy history is attributed once without deleting costs or resetting current week',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vibe-weekly-migrate-')),p=join(dir,'db');
 let old=new LegacyLedger(p),a=randomUUID(),b=randomUUID();old.reserve(a,20,'a');old.finish(a,'settled',usage,200);old.reserve(b,25,'operator');old.close();
 const l=new Ledger(p,{mapLegacyStudents:true});
 assert.equal(l.status(1).confirmed_tokens,17);assert.equal(l.status().uncertain_ceiling,CALL_DEBIT);
 assert.equal(l.overview().lifetime.attempts,2);const stamp=l.db.prepare('SELECT period_start FROM request_scopes WHERE request_id=?').get(a).period_start;l.close();
 const reopened=new Ledger(p,{mapLegacyStudents:true});assert.equal(reopened.db.prepare('SELECT period_start FROM request_scopes WHERE request_id=?').get(a).period_start,stamp);
 reopened.close();rmSync(dir,{recursive:true,force:true});
});
test('Variable body reserve applies only to the correct user and includes cached usage',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial}),id=randomUUID(),reserve=400000;
 l.reserve(id,20,'h',reserve,1);assert.equal(l.status(1).remainingAuthorizationTokens,600000);assert.equal(l.status(2).remainingAuthorizationTokens,1000000);
 l.finish(id,'settled',usage,200);assert.equal(l.status(1).remainingAuthorizationTokens,999983);l.close();
});
test('Invalid subject is rejected before any scope or request record can be created',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 for(const student of [0,6,-1,'1',NaN])assert.throws(()=>l.reserve(randomUUID(),20,'h',CALL_DEBIT,student),/SUBJECT_INVALID/);
 assert.equal(l.overview().lifetime.attempts,0);l.close();
});
test('Weekly ceiling cannot be changed through SQL and scope inserts are atomic',()=>{
 const l=new Ledger(':memory:',{clock:()=>initial});
 assert.throws(()=>l.db.prepare('UPDATE weekly_budgets SET limit_tokens=? WHERE student=1').run(2000000));
 const id=randomUUID();l.db.exec("CREATE TRIGGER deny_scope BEFORE INSERT ON request_scopes BEGIN SELECT RAISE(ABORT,'scope failure'); END;");
 assert.throws(()=>l.reserve(id,20,'h',CALL_DEBIT,1));assert.equal(l.db.prepare('SELECT count(*) n FROM model_requests').get().n,0);l.close();
});
test('Student bearer selects its own quota, cannot claim another credential or see the overview',async t=>{
 const l=new Ledger(':memory:',{clock:()=>initial}),dir=mkdtempSync(join(tmpdir(),'vibe-weekly-auth-')),socket=join(dir,'sock');
 const cap='a'.repeat(64),one='b'.repeat(64),two='c'.repeat(64);let calls=0;
 const server=createGateway({ledger:l,capability:cap,studentCapabilities:[{student:1,capability:one},{student:2,capability:two}],vault:{get:()=> 'sk-'+'x'.repeat(32),metadata:()=>[{id:20}]},fetchImpl:async()=>{calls++;throw new Error('must not dispatch')}});
 server.listen(socket);await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));l.close();rmSync(dir,{recursive:true,force:true})});
 async function request(token,credential,path='/v1/status',method='GET'){
  return new Promise((resolve,reject)=>{
   const req=http.request({socketPath:socket,path,method,headers:{Authorization:'Bearer '+token,'X-Vibe-Credential':String(credential),'Content-Type':'application/json','X-Vibe-Request-Id':randomUUID()}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text,json:text?JSON.parse(text):null}))});req.on('error',reject);req.end(method==='POST'?'{}':undefined);
  });
 }
 const own=await request(one,20);assert.equal(own.status,200);assert.equal(own.json.budget.student,1);assert.equal(own.json.budget.period,'weekly');assert.equal(own.json.overview,undefined);assert.equal(own.json.credentials,undefined);
 assert.equal((await request(one,21)).status,403);assert.equal((await request(one,21,'/v1/messages','POST')).status,403);
 assert.equal((await request('d'.repeat(64),20)).status,403);
 const admin=await request(cap,20);assert.equal(admin.json.overview.students.length,5);assert.equal(calls,0);
});
