
/** Explicit paid acceptance: short replies and one tiny tool cycle; user global cap remains enforced. */
import{readFileSync,writeFileSync}from'node:fs';
import{randomBytes}from'node:crypto';
import{execFileSync}from'node:child_process';
import{DatabaseSync}from'node:sqlite';
const origin='https://80.249.145.94',account=JSON.parse(readFileSync('/var/lib/vibe-os/portal-private/student-logins.json'))[4];
let cookie='',csrf='',project;
const budget=()=>JSON.parse(execFileSync('node',['/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs','status'])).overview.students.find(row=>row.student===5);
const before=budget(),checks=[],runs=[];
function assert(ok,msg){if(!ok)throw new Error(msg)}
assert(before.limitTokens===1000000&&before.remainingAuthorizationTokens>6*131072,'Insufficient bounded authorization for canary');
async function api(method,path,body,expected=200){
 const res=await fetch(origin+'/api'+path,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const value=await res.json();assert(res.status===expected,path+' '+res.status+' '+value.error);return value;
}
async function settle(id){
 const end=Date.now()+240000;
 while(Date.now()<end){
  const run=await api('GET','/runs/'+id);
  if(!['queued','running'].includes(run.state)){assert(run.state==='completed','Run '+run.state+' '+run.error);return run}
  await new Promise(r=>setTimeout(r,1000));
 }throw new Error('Canary timeout; cancel the owned run');
}
try{
 await api('POST','/auth/login',{login:account.login,password:account.password});csrf=(await api('GET','/me')).csrf;
 project=(await api('POST','/projects',{name:'Короткая проверка DeepSeek reasoning',kind:'python'})).id;

 const chat=(await api('POST','/projects/'+project+'/chats',{name:'Переключение в одном разговоре'})).id;
 for(const mode of ['high','off','max']){
  await api('PATCH','/chats/'+chat,{reasoningMode:mode});
  const prompt='Ответь ровно '+mode.toUpperCase()+'_OK. Без инструментов и объяснений.';
  const queued=await api('POST','/chats/'+chat+'/messages',{text:prompt,reasoningMode:mode});runs.push(queued.id);
  await settle(queued.id);
  const detail=await api('GET','/chats/'+chat),answer=detail.messages.filter(m=>m.role==='assistant').at(-1);
  assert(answer?.text.includes(mode.toUpperCase()+'_OK'),'Reply missing');
  checks.push({mode,completed:true,sameChat:true,maxTokens:65536});
  console.log('Existing chat switched to '+mode+'.');
 }
 const db=new DatabaseSync('/var/lib/vibe-os/portal/portal.sqlite',{readOnly:true});
 const snapshots=runs.map(id=>db.prepare('SELECT id,reasoning_mode,state FROM runs WHERE id=?').get(id));db.close();
 assert(snapshots.every((row,i)=>row.reasoning_mode===['high','off','max'][i]&&row.state==='completed'),'Run setting snapshots changed');
 const after=budget();assert(after.limitTokens===1000000&&after.confirmed_tokens>before.confirmed_tokens&&after.uncertain_ceiling===0,'Budget settlement');
 const paid=after.attempts-before.attempts;
 assert(paid>=3&&paid<=6,'Unexpected request count (concurrent user traffic is accounted separately)');
 const historyDir='/srv/vibe-os/data/student-projects/'+project+'/engine/sessions';
 const python="from pathlib import Path\nimport json\nn=0\nfor p in Path("+JSON.stringify(historyDir)+").rglob('*'):\n if p.is_file() and p.suffix=='.jsonl':\n  for line in p.read_text().splitlines():\n   n+=line.count('\"type\":\"reasoning\"')+line.count('\"type\": \"reasoning\"')\nprint(n)";
 const reasoningBlocks=Number(execFileSync('python3',['-c',python],{encoding:'utf8'}).trim());
 assert(reasoningBlocks>0,'Native reasoning not present in durable history');
 writeFileSync('/opt/vibe-os/platform/evidence/reasoning-replay-acceptance.json',JSON.stringify({passed:true,checks,runSnapshotModes:snapshots.map(s=>s.reasoning_mode),nativeReasoningBlocks:reasoningBlocks,budgetBefore:before,budgetAfter:after,newPaidCalls:paid,newConfirmedTokens:after.confirmed_tokens-before.confirmed_tokens,paidProof:'same existing chat switched high -> off -> max; native history preserved'},null,2)+'\n');
 console.log(JSON.stringify({passed:true,paidCalls:paid,newConfirmedTokens:after.confirmed_tokens-before.confirmed_tokens,totalConfirmedTokens:after.confirmed_tokens,nativeReasoningBlocks:reasoningBlocks}));
}finally{
 for(const id of runs){try{const run=await api('GET','/runs/'+id);if(['running','queued'].includes(run.state))await api('POST','/runs/'+id+'/cancel',{})}catch{}}
 if(project)await api('DELETE','/projects/'+project,{});
 if(cookie)await api('POST','/auth/logout',{});
}
