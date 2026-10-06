
/** Root-operated acceptance of protected Harness resumes, model outage and session revocation. No model prompts. */
import http from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const origin='https://80.249.145.94';
const accounts=JSON.parse(readFileSync('/var/lib/vibe-os/portal-private/student-logins.json'));
const seed=JSON.parse(readFileSync('/opt/vibe-os/platform/evidence/student-seed.json'));
const capability=readFileSync('/var/lib/vibe-os/portal-private/broker-capability','utf8').trim();
const budget=()=>JSON.parse(execFileSync('/usr/local/bin/node',['/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs','status'])).budget;
const checks=[],before=budget();
function assert(value,message){if(!value)throw new Error(message)}
class Student{
 constructor(account){this.account=account;this.cookie='';this.csrf=''}
 async login(password=this.account.password){await this.call('POST','/auth/login',{login:this.account.login,password});this.me=await this.call('GET','/me');this.csrf=this.me.csrf;return this}
 async call(method,path,body,expected=200){
  const res=await fetch(origin+'/api'+path,{method,headers:{Origin:origin,Cookie:this.cookie,'X-CSRF-Token':this.csrf,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const set=res.headers.get('set-cookie');if(set)this.cookie=set.split(';')[0];
  const data=await res.json();if(res.status!==expected)throw new Error(method+' '+path+' status '+res.status+' code '+data.error);
  return data;
 }
}
function inspect(project,chat){
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath:'/run/vibe-os-portal/broker.sock',path:'/v1/request',method:'POST',headers:{Authorization:'Bearer '+capability,'Content-Type':'application/json'}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>{text+=c;if(text.length>64000)req.destroy(new Error('Response limit'))});res.on('error',reject);
   res.on('end',()=>{
    try{assert(res.statusCode===200,'Private inspect status '+res.statusCode);const blocks=text.split('\n\n');const item=blocks.find(x=>x.startsWith('event: inspected\n'));assert(item,'Cold inspection did not complete');resolve(JSON.parse(item.split('\ndata: ')[1]));}catch(e){reject(e)}
   });
  });
  req.on('error',reject);req.setTimeout(60000,()=>req.destroy(new Error('Cold inspection timeout')));
  req.end(JSON.stringify({op:'inspect',project,chat,run:randomBytes(16).toString('hex')}));
 });
}
const students=[],fixtures=[];
let database,synthetic;
try{
 for(const account of accounts)students.push(await new Student(account).login());
 const firstChats=await students[0].call('GET','/projects/'+seed.webProject+'/chats');
 const chat=firstChats.find(c=>c.name==='Первые идеи для проекта');assert(chat,'Live chat missing');
 const resumed=await inspect(seed.webProject,chat.id);
 assert(resumed.resumed&&resumed.cursor>0&&resumed.paidCalls===0,'Protected existing history not resumed');
 checks.push('existing real Harness history resumed with persisted cursor and no model request');
 for(let i=1;i<5;i++){
  const p=await students[i].call('POST','/projects',{name:'Временная проверка профиля',kind:'python'});fixtures.push([students[i],p.id]);
  const chats=await students[i].call('GET','/projects/'+p.id+'/chats');
  const r=await inspect(p.id,chats[0].id);assert(r.paidCalls===0&&r.cursor===0,'Fresh student history mismatch');
  checks.push('student '+(i+1)+' protected engine initialized with its own profile');
 }
 execFileSync('systemctl',['stop','vibe-os-model-gateway.service']);await new Promise(r=>setTimeout(r,1200));
 try{
  assert(execFileSync('systemctl',['is-active','vibe-os-portal','vibe-os-portal-web','vibe-os-workspace-broker'],{encoding:'utf8'}).trim().split('\n').every(v=>v==='active'),'Portal stopped with model');
  const status=await students[0].call('GET','/status');assert(status.model.ready===false,'Unavailable model reported ready');
  const file=await students[0].call('GET','/projects/'+seed.webProject+'/file?path=NOTES.md');assert(file.text.includes('Идеи'),'Editor unavailable with model');
  const py=await students[0].call('POST','/projects/'+seed.pythonProject+'/run',{path:'main.py'});assert(py.exitCode===0&&py.cgroupEmpty,'Manual execution depends on model');
  await students[0].call('POST','/chats/'+chat.id+'/messages',{text:'Этот запрос должен быть отклонён до отправки'},503);
  checks.push('model outage preserves HTTPS, file access and isolated execution; prompts rejected before admission');
 }finally{execFileSync('systemctl',['start','vibe-os-model-gateway.service'])}
 await new Promise(r=>setTimeout(r,1200));assert((await students[0].call('GET','/status')).model.ready,'Model not ready after recovery');
 database=new DatabaseSync('/var/lib/vibe-os/portal/portal.sqlite');database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
 synthetic=randomBytes(16).toString('hex');const now=Date.now();
 database.prepare('INSERT INTO runs(id,chat_id,project_id,user_id,state,prompt,base_revision,partial,error,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(synthetic,chat.id,seed.webProject,students[0].me.id,'running','private revocation acceptance',1,'',null,now,now);
 const res=await fetch(origin+'/api/runs/'+synthetic+'/events',{headers:{Cookie:students[0].cookie},signal:AbortSignal.timeout(15000)});
 assert(res.status===200,'SSE unavailable');const reader=res.body.getReader();await reader.read();
 await students[0].call('POST','/auth/logout',{});
 const ended=await Promise.race([(async()=>{while(!(await reader.read()).done){}return true})(),new Promise(r=>setTimeout(()=>r(false),4000))]);
 assert(ended,'Logout did not close already open SSE');await students[0].call('GET','/me',undefined,401);
 database.prepare('DELETE FROM runs WHERE id=?').run(synthetic);synthetic=null;
 checks.push('logout revokes HTTP session and closes an already open SSE stream');
 const fifth=students[4],originalCookie=fifth.cookie;
 const temporary='Vibe-Temporary-'+randomBytes(18).toString('base64url');
 await fifth.call('PATCH','/me',{oldPassword:fifth.account.password,password:temporary});
 const old=await fetch(origin+'/api/me',{headers:{Cookie:originalCookie}});assert(old.status===401,'Changed password left old session active');
 let restored=false;
 try{await fifth.login(temporary);await fifth.call('PATCH','/me',{oldPassword:temporary,password:fifth.account.password});restored=true}
 finally{if(!restored){await fifth.login(temporary);await fifth.call('PATCH','/me',{oldPassword:temporary,password:fifth.account.password})}}
 await fifth.login();checks.push('password change invalidates old sessions; original supplied password restored');
 const after=budget();assert(after.attempts===before.attempts&&after.confirmed_tokens===before.confirmed_tokens&&after.limitTokens===1000000,'Free acceptance changed model budget');
 checks.push('all checks made zero paid requests and preserve the global million-token authorization');
}finally{
 execFileSync('systemctl',['start','vibe-os-model-gateway.service']);
 if(database){if(synthetic)database.prepare('DELETE FROM runs WHERE id=?').run(synthetic);database.close()}
 for(const [student,id]of fixtures)await student.call('DELETE','/projects/'+id,{});
 for(let i=1;i<students.length;i++)assert((await students[i].call('GET','/projects')).length===0,'Other cabinet not empty');
 for(let i=1;i<students.length;i++)await students[i].call('POST','/auth/logout',{});
}
const report={suite:'student-private-lifecycle',passed:true,count:checks.length,checks,paidCalls:0,budgetBefore:before,budgetAfter:budget(),otherCabinetsRestoredEmpty:true};
writeFileSync('/opt/vibe-os/platform/evidence/student-lifecycle.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,checks:checks.length,paidCalls:0,attempts:report.budgetAfter.attempts,confirmedTokens:report.budgetAfter.confirmed_tokens}));
