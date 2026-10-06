/** Root SSH operator; token values and plaintext provider keys are never emitted. */
import http from 'node:http'
import {readFileSync,writeFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
export async function callGateway(path,credentialId=20,body,requestId=randomUUID()){
 const token=readFileSync('/var/lib/vibe-os/poc-model/capability','utf8').trim()
 const data=body?JSON.stringify(body):''
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath:'/run/vibe-os-model/gateway.sock',path,method:body?'POST':'GET',signal:AbortSignal.timeout(65000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Vibe-Credential':String(credentialId),'X-Vibe-Request-Id':requestId}},res=>{
   const parts=[];let n=0
   res.on('data',p=>{n+=p.length;if(n>1048576)req.destroy(new Error('GATEWAY_RESPONSE_LIMIT'));else parts.push(p)})
   res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(parts).toString()}))
  });req.on('error',reject);req.end(data)
 })
}
async function main(){
 if(process.getuid()!==0)throw new Error('ROOT_OPERATOR_REQUIRED')
 const command=process.argv[2]
 if(command==='status'){const r=await callGateway('/v1/status');if(r.status!==200)throw new Error('STATUS_FAILED');console.log(r.text);return}
 if(command==='models'){
  const results=[]
  for(let id=20;id<=27;id++){
   const r=await callGateway('/v1/models',id)
   results.push({id,passed:r.status===200,...r.status===200?JSON.parse(r.text):{status:r.status}})
  }
  const report={suite:'eight-credential-discovery',paidCalls:0,passed:results.every(x=>x.passed),results}
  writeFileSync('/opt/vibe-os/platform/evidence/deepseek-key-discovery.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;return
 }
 if(command==='smoke-all'){
  const before=JSON.parse((await callGateway('/v1/status')).text).budget
  if(before.attempts!==0)throw new Error('SMOKE_ALREADY_STARTED_DO_NOT_REPLAY')
  const results=[]
  for(let id=20;id<=27;id++){
   const body={model:'deepseek-flash',stream:true,max_tokens:32,thinking:{type:'disabled'},messages:[{role:'user',content:[{type:'text',text:'Reply with exactly VIBE_OK and nothing else.'}]}]}
   const r=await callGateway('/v1/messages',id,body)
   const events=r.text.split('\n\n').flatMap(frame=>{
    const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n')
    if(!data)return[]
    try{return[JSON.parse(data)]}catch(_invalidFrame){return[]}
   })
   const answer=events.filter(e=>e.type==='content_block_delta'&&e.delta?.type==='text_delta').map(e=>e.delta.text).join('')
   const passed=r.status===200&&events.some(e=>e.type==='message_stop')&&answer.trim()==='VIBE_OK'&&!events.some(e=>e.type==='error')
   results.push({id,passed,status:r.status,reply:answer.slice(0,80)})
   console.log(JSON.stringify(results.at(-1)))
   if(!passed)break
  }
  const after=JSON.parse((await callGateway('/v1/status')).text).budget
  const report={suite:'eight-credential-live-messages',passed:results.length===8&&results.every(x=>x.passed),results,budgetBefore:before,budgetAfter:after}
  writeFileSync('/opt/vibe-os/platform/evidence/deepseek-key-smokes.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({passed:report.passed,budget:after}));if(!report.passed)process.exitCode=1;return
 }
 throw new Error('UNKNOWN_OPERATOR_COMMAND')
}
if(process.argv[1]===new URL(import.meta.url).pathname)main().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'OPERATOR_FAILED');process.exitCode=1})
