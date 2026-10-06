/** Fixed-destination Unix model gateway. No credential or upstream error body reaches clients or logs. */
import http from 'node:http'
import {readFileSync,unlinkSync,chmodSync} from 'node:fs'
import {join} from 'node:path'
import {timingSafeEqual,createHash} from 'node:crypto'
import {Vault} from '../../packages/credentials/vault.mjs'
import {Ledger} from './ledger.mjs'
const UPSTREAM='https://api.deepseek.com'
export const MAX_BODY=16384,MAX_OUTPUT=2048
function fail(code,status=400){const e=new Error(code);e.status=status;return e}
function object(v){if(!v||typeof v!=='object'||Array.isArray(v))throw fail('INVALID_OBJECT');return v}
export function validateBody(value){
 const b=object(value),allowed=['model','stream','max_tokens','messages','system','tools','thinking','temperature','stop_sequences']
 if(Object.keys(b).some(k=>!allowed.includes(k)))throw fail('UNSUPPORTED_FIELD')
 if(b.model!=='deepseek-flash'||b.stream!==true||!Number.isSafeInteger(b.max_tokens)||b.max_tokens<1||b.max_tokens>MAX_OUTPUT)throw fail('MODEL_OR_OUTPUT_LIMIT')
 if(b.thinking?.type!=='disabled'||Object.keys(b.thinking).length!==1)throw fail('THINKING_MUST_BE_DISABLED')
 if(!Array.isArray(b.messages)||!b.messages.length||b.messages.length>32)throw fail('MESSAGE_LIMIT')
 let blocks=0
 function content(items,depth=0){
  if(depth>2||!Array.isArray(items)||items.length>16)throw fail('CONTENT_LIMIT')
  for(const block of items){
   blocks++;if(blocks>64)throw fail('CONTENT_LIMIT')
   const x=object(block)
   if(x.type==='text'){if(typeof x.text!=='string'||Object.keys(x).some(k=>!['type','text'].includes(k)))throw fail('TEXT_ONLY')}
   else if(x.type==='tool_use'){if(typeof x.id!=='string'||typeof x.name!=='string')throw fail('TOOL_FORMAT');object(x.input);if(Object.keys(x).some(k=>!['type','id','name','input'].includes(k)))throw fail('TOOL_FORMAT')}
   else if(x.type==='tool_result'){if(typeof x.tool_use_id!=='string')throw fail('TOOL_FORMAT');if(typeof x.content!=='string')content(x.content,depth+1);if(Object.keys(x).some(k=>!['type','tool_use_id','content','is_error'].includes(k)))throw fail('TOOL_FORMAT')}
   else throw fail('TEXT_ONLY')
  }
 }
 for(const m of b.messages){if(!['user','assistant'].includes(m.role)||Object.keys(m).some(k=>!['role','content'].includes(k)))throw fail('MESSAGE_FORMAT');content(m.content)}
 if(b.system!==undefined){if(typeof b.system!=='string')content(b.system)}
 if(b.tools!==undefined){
  if(!Array.isArray(b.tools)||b.tools.length>8)throw fail('TOOL_LIMIT')
  for(const t of b.tools){if(!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)||typeof t.description!=='string'||Object.keys(t).some(k=>!['name','description','input_schema'].includes(k)))throw fail('TOOL_FORMAT');object(t.input_schema)}
 }
 if(b.temperature!==undefined&&(typeof b.temperature!=='number'||b.temperature<0||b.temperature>2))throw fail('TEMPERATURE')
 if(b.stop_sequences!==undefined&&(!Array.isArray(b.stop_sequences)||b.stop_sequences.length>4||b.stop_sequences.some(s=>typeof s!=='string'||Buffer.byteLength(s)>64)))throw fail('STOP_LIMIT')
 return b
}
function usageFields(raw,base){
 if(!raw||typeof raw!=='object')throw fail('PROVIDER_USAGE_INVALID',502)
 const map={input_tokens:'input',output_tokens:'output',cache_read_input_tokens:'cacheRead',cache_creation_input_tokens:'cacheWrite'}
 for(const [key,target]of Object.entries(map))if(raw[key]!==undefined){if(!Number.isSafeInteger(raw[key])||raw[key]<0)throw fail('PROVIDER_USAGE_INVALID',502);base[target]=raw[key]}
}
async function write(res,data){
 if(res.destroyed)throw fail('CLIENT_DISCONNECTED')
 if(res.write(data))return
 await new Promise((resolve,reject)=>{
  const cleanup=()=>{res.off('drain',drained);res.off('close',closed);res.off('error',errored)}
  const drained=()=>{cleanup();resolve()}
  const closed=()=>{cleanup();reject(fail('CLIENT_DISCONNECTED'))}
  const errored=()=>{cleanup();reject(fail('CLIENT_DISCONNECTED'))}
  res.once('drain',drained);res.once('close',closed);res.once('error',errored)
 })
}
export function createGateway({ledger,vault,capability,fetchImpl=fetch}){
 const expected=Buffer.from('Bearer '+capability)
 return http.createServer(async(req,res)=>{
  let admitted=false,finished=false,requestId,status
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),60000)
  res.on('close',()=>{if(!res.writableEnded)control.abort()})
  try{
   const received=Buffer.from(String(req.headers.authorization??''))
   if(received.length!==expected.length||!timingSafeEqual(received,expected))throw fail('UNAUTHORIZED',403)
   if(req.method==='GET'&&req.url==='/v1/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({budget:ledger.status(),credentials:vault.metadata()}));return}
   const keyId=Number(req.headers['x-vibe-credential'])
   if(!Number.isInteger(keyId)||keyId<20||keyId>27)throw fail('CREDENTIAL_SCOPE',403)
   if(req.method==='GET'&&req.url==='/v1/models'){
    const response=await fetchImpl(UPSTREAM+'/models',{headers:{Authorization:'Bearer '+vault.get(keyId)},signal:control.signal,redirect:'error'})
    status=response.status
    if(!response.ok)throw fail('PROVIDER_HTTP_'+status,502)
    const text=await boundedText(response,65536),data=JSON.parse(text)
    if(!Array.isArray(data.data))throw fail('MODEL_DISCOVERY_INVALID',502)
    const models=data.data.filter(m=>m.id==='deepseek-flash'||m.id==='deepseek-v4-pro').map(m=>({id:m.id,contextWindow:m.context_window,maxOutputTokens:m.max_output_tokens}))
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({credentialId:keyId,models}));return
   }
   if(req.method!=='POST'||req.url!=='/v1/messages')throw fail('ROUTE_NOT_ALLOWED',404)
   if(req.headers['content-type']!=='application/json')throw fail('CONTENT_TYPE')
   requestId=String(req.headers['x-vibe-request-id']??'')
   if(!/^[a-f0-9-]{36}$/.test(requestId))throw fail('REQUEST_ID')
   const parts=[];let n=0
   for await(const p of req){n+=p.length;if(n>MAX_BODY)throw fail('REQUEST_BYTES_LIMIT',413);parts.push(p)}
   const raw=Buffer.concat(parts),body=validateBody(JSON.parse(raw.toString('utf8')))
   const key=vault.get(keyId)
   ledger.reserve(requestId,keyId,createHash('sha256').update(raw).digest('hex'));admitted=true
   const response=await fetchImpl(UPSTREAM+'/anthropic/v1/messages',{
    method:'POST',redirect:'error',signal:control.signal,
    headers:{'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json','Accept':'text/event-stream'},
    body:JSON.stringify({...body,metadata:{user_id:'vibe-poc-student'}})
   })
   status=response.status
   if(!response.ok){ledger.finish(requestId,'failed',undefined,status);finished=true;await response.body?.cancel();throw fail('PROVIDER_HTTP_'+status,502)}
   if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw fail('PROVIDER_STREAM_INVALID',502)
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Vibe-Request-Id':requestId})
   const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true})
   let pending='',bytes=0,start=false,terminal=false,outputSeen=false
   const usage={input:0,output:0,cacheRead:0,cacheWrite:0,total:0}
   try{
    while(true){
     const part=await reader.read()
     if(part.done)break
     bytes+=part.value.length;if(bytes>1048576)throw fail('PROVIDER_BYTES_LIMIT',502)
     pending+=decoder.decode(part.value,{stream:true});pending=pending.replace(/\r\n/g,'\n')
     if(Buffer.byteLength(pending)>65536)throw fail('PROVIDER_FRAME_LIMIT',502)
     let boundary
     while((boundary=pending.indexOf('\n\n'))>=0){
      const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2)
      const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')
      if(!data){await write(res,frame+'\n\n');continue}
      const event=JSON.parse(data)
      if(event.type==='error')throw fail('PROVIDER_STREAM_ERROR',502)
      if(event.type==='message_start'){if(start)throw fail('PROVIDER_USAGE_INVALID',502);start=true;usageFields(event.message?.usage,usage);if(event.message?.usage?.input_tokens===undefined)throw fail('PROVIDER_USAGE_INVALID',502)}
      if(event.type==='message_delta'&&event.usage){usageFields(event.usage,usage);if(event.usage.output_tokens!==undefined)outputSeen=true}
      if(event.type==='message_stop'){
       if(!start||!outputSeen||usage.output>body.max_tokens)throw fail('PROVIDER_USAGE_INVALID',502)
       usage.total=usage.input+usage.output+usage.cacheRead+usage.cacheWrite
       ledger.finish(requestId,'settled',usage,status);finished=true;terminal=true
       if(usage.total>65536)throw fail('PROVIDER_USAGE_EXCEEDS_ENVELOPE',502)
       await write(res,frame+'\n\n');res.end();await reader.cancel();return
      }
      await write(res,frame+'\n\n')
     }
    }
    if(!terminal)throw fail('PROVIDER_STREAM_INCOMPLETE',502)
   }finally{reader.releaseLock()}
  }catch(error){
   if(admitted&&!finished){try{ledger.finish(requestId,'uncertain',undefined,status)}catch(_ledgerFailure){/* Existing debit remains; startup reconciles sent requests. */}}
   const safe=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'GATEWAY_REQUEST_FAILED'
   if(!res.headersSent){res.writeHead(error.status??502,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:safe}))}
   else if(!res.destroyed){res.end('event: error\ndata: '+JSON.stringify({type:'error',error:{type:'gateway_error',message:safe}})+'\n\n')}
  }finally{clearTimeout(timer);control.abort()}
 })
}
async function boundedText(response,max){
 let bytes=0,parts=[]
 if(!response.body)throw fail('PROVIDER_BODY_MISSING',502)
 for await(const p of response.body){bytes+=p.length;if(bytes>max)throw fail('PROVIDER_BYTES_LIMIT',502);parts.push(Buffer.from(p))}
 return Buffer.concat(parts).toString('utf8')
}
export function start(){
 const credentials=process.env.CREDENTIALS_DIRECTORY
 if(!credentials)throw new Error('SYSTEMD_CREDENTIALS_REQUIRED')
 const vault=new Vault(readFileSync(join(credentials,'master-key')),'/var/lib/vibe-os/credentials')
 if(vault.metadata().length!==8)throw new Error('EIGHT_CREDENTIALS_REQUIRED')
 const capability=readFileSync(join(credentials,'engine-capability'),'utf8').trim()
 if(!/^[a-f0-9]{64}$/.test(capability))throw new Error('INVALID_CAPABILITY')
 const ledger=new Ledger('/var/lib/vibe-os/model-budget/tokens.sqlite')
 const socket='/run/vibe-os-model/gateway.sock';try{unlinkSync(socket)}catch(e){if(e.code!=='ENOENT')throw e}
 const server=createGateway({ledger,vault,capability})
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=4
 server.listen(socket,()=>{chmodSync(socket,0o660);console.log('Bounded model gateway ready; eight encrypted credentials')})
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(()=>{ledger.close();process.exit(0)});setTimeout(()=>process.exit(1),5000).unref()})
}
if(process.argv[1]===new URL(import.meta.url).pathname)start()
