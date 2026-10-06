/** Private school PoC protocol with bounded history and durable final settlement. */
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'
import {JsonRpcLineTransport} from '@deepseek-ai/dsh-sdk-protocol'
import type {AgentHandle} from '@deepseek-ai/dsh-agent'
import type {Session,SessionId} from '@deepseek-ai/dsh-session'
import {brandString} from '@deepseek-ai/dsh-brand'
import {createUserMessage,ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {Transform} from 'node:stream'
import {RunnerClient,object,text} from './runner-client.js'
export const name='school-sdk'
export const inject=['agents','sessions','sessionPersistence','llm','tools','loader']
export interface Config { maxLogBytes:number;maxLogEvents:number;maxEventBytes:number;maxSessions:number;maxReadBytes:number;maxSteps:number;provider:string;model:string;maxTokens:number }
export const Config:Schema<Config>=Schema.object({
 maxLogBytes:Schema.number().default(8*1024*1024),
 maxLogEvents:Schema.number().default(20000),
 maxEventBytes:Schema.number().default(128*1024),
 maxSessions:Schema.number().default(16),
 maxReadBytes:Schema.number().default(230*1024),
 maxSteps:Schema.number().default(12),
 provider:Schema.string().default('school-mock'),
 model:Schema.string().default('poc-fixed'),
 maxTokens:Schema.number().step(1).min(1).max(65536).default(1024),
})
interface Entry { handle:AgentHandle;run?:{id:string;done:Promise<void>};error?:string }
class BoundedLines extends Transform {
 private pending=Buffer.alloc(0)
 override _transform(chunk:Buffer,_encoding:BufferEncoding,callback:(error?:Error|null)=>void):void {
  try {
   let at=0
   while(at<chunk.length){
    const newline=chunk.indexOf(10,at),end=newline<0?chunk.length:newline+1
    const piece=chunk.subarray(at,end)
    if(this.pending.length+piece.length>65536)throw new Error('RPC frame exceeds 64 KiB')
    this.pending=Buffer.concat([this.pending,piece])
    if(newline>=0){
      const value=object(JSON.parse(this.pending.toString('utf8')))
      if(value.jsonrpc!=='2.0'||typeof value.method!=='string'||value.method.length>64)throw new Error('Invalid RPC frame')
      if(value.id!==undefined&&!(typeof value.id==='string'&&value.id.length<=64)&&!(typeof value.id==='number'&&Number.isSafeInteger(value.id)))throw new Error('Invalid RPC id')
      this.push(this.pending);this.pending=Buffer.alloc(0)
    }
    at=end
   }
   callback()
  }catch(error){callback(error instanceof Error?error:new Error(String(error)))}
 }
}
function id(value:unknown):string{
 const v=text(value)
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(v))throw new Error('Invalid identifier')
 return v
}
export function apply(ctx:Context,config:Config):void{
 for(const [key,value] of Object.entries(config)){if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<1))throw new Error('Invalid '+key)}
 if(!((config.provider==='school-mock'&&config.model==='poc-fixed')||(config.provider==='school-deepseek'&&config.model==='deepseek-flash')))throw new Error('Invalid school model route')
 const entries=new Map<string,Entry>(),client=new RunnerClient()
 const input=new BoundedLines()
 process.stdin.pipe(input)
 const transport=new JsonRpcLineTransport(input,process.stdout)
 input.on('error',()=>{void ctx.root.fiber.dispose().finally(()=>process.exit(1))})
 let reasoningMode='off'
 let initialized=false,closing=false,serial:Promise<unknown>=Promise.resolve()
 async function bounded(sid:SessionId,allowPending=false):Promise<void>{
  const stat=await ctx.sessionPersistence.stat(sid)
  if(stat&&stat.sizeBytes===undefined&&allowPending&&entries.has(String(sid)))return
  if(stat&&((stat.sizeBytes??Number.POSITIVE_INFINITY)>config.maxLogBytes||(stat.eventCount??0)>config.maxLogEvents))throw new Error('SESSION_HISTORY_LIMIT: create a new independent session')
 }
 async function checkpoint(session:Session):Promise<number>{
  await bounded(session.id,true)
  const required=session.seq
  await ctx.sessions.flush(session)
  await ctx.sessionPersistence.flush()
  await bounded(session.id)
  const handle=await ctx.sessionPersistence.open(session.id,'read')
  try {
   const snapshot=await handle.read()
   if(snapshot.events.length>config.maxLogEvents)throw new Error('SESSION_EVENT_LIMIT')
   const cursor=snapshot.events.length
   if(cursor<required)throw new Error('DURABLE_CURSOR_NOT_ACKNOWLEDGED')
   return cursor
  }finally{await handle.close()}
 }
 async function open(params:Record<string,unknown>):Promise<unknown>{
  const sid=id(params.sessionId)
  if(entries.has(sid))return {sessionId:sid,opened:true}
  if(entries.size>=config.maxSessions)throw new Error('SESSION_ENTITY_LIMIT')
  const branded=brandString<SessionId>(sid)
  await bounded(branded)
  const stat=await ctx.sessionPersistence.stat(branded)
  const options={provider:config.provider,model:config.model,maxTokens:config.maxTokens,...(config.provider==='school-deepseek'?{reasoningEffort:ReasoningEffortId(reasoningMode)}:{})}
  const handle=stat?await ctx.agents.resume({resumeSessionId:branded,agentOptions:options}):await ctx.agents.create({sessionId:branded,meta:{cwd:'/workspace'},agentOptions:options})
  entries.set(sid,{handle})
  const persistedCursor=await checkpoint(handle.agent.session)
  return {sessionId:sid,opened:true,resumed:!!stat,persistedCursor}
 }
 async function request(method:string,params:Record<string,unknown>):Promise<unknown>{
  if(method==='initialize'){
   await ctx.loader.await()
   const mode=params.reasoningMode??'off';if(typeof mode!=='string'||!['off','low','high','max'].includes(mode))throw new Error('INVALID_REASONING_MODE');reasoningMode=mode
   if(params.provider!==config.provider||params.model!==config.model)throw new Error(config.provider==='school-mock'?'Only the keyless school-mock route is enabled':'Only the configured school model route is enabled')
   await ctx.llm.resolveModelInfo(config.provider,config.model)
   initialized=true
   return {reasoningMode,maxTokens:config.maxTokens,serverInfo:{name:'vibe-os-school-poc',version:'0.0.1'},features:['open','read','cancel','delta','durable-settlement'],paidCalls:config.provider==='school-deepseek'}
  }
  if(!initialized||closing)throw new Error('Runtime not available')
  if(method==='session/open')return open(params)
  if(method==='shutdown'){
   closing=true
   for(const entry of entries.values())entry.handle.agent.cancel({kind:'user'})
   await Promise.allSettled([...entries.values()].map(e=>e.run?.done))
   for(const entry of entries.values())await entry.handle.dispose()
   entries.clear()
   await client.operation({op:'barrier'})
   setImmediate(()=>void transport.flush().then(()=>ctx.root.fiber.dispose()).then(()=>process.exit(0)))
   return {}
  }
  const sid=id(params.sessionId),entry=entries.get(sid)
  if(!entry)throw new Error('Open this session first')
  if(method==='session/prompt'){
   if(entry.run)throw new Error('A run is already active')
   const runId=id(params.runId),content=text(params.text)
   if(Buffer.byteLength(content)>8192)throw new Error('PROMPT_LIMIT')
   await bounded(entry.handle.agent.session.id,true)
   entry.error=undefined
   const message=createUserMessage({content:[{type:'text',text:content}],source:{kind:'user'}})
   entry.handle.agent.followup(message)
   const finished=entry.handle.agent.whenIdle().then(async()=>{
    await client.operation({op:'barrier'})
    const cursor=await checkpoint(entry.handle.agent.session)
    transport.notify('session.settled',{sessionId:sid,runId,durable:true,persistedCursor:cursor,quiescent:true,...entry.error?{error:entry.error}:{}})
   }).catch(error=>{
    transport.notify('session.failure',{sessionId:sid,runId,durable:false,error:error instanceof Error?error.message:String(error)})
   }).finally(()=>{entry.run=undefined})
   entry.run={id:runId,done:finished}
   const cursor=await checkpoint(entry.handle.agent.session)
   return {messageId:message.id,runId,accepted:true,durable:true,persistedCursor:cursor}
  }
  if(method==='session/cancel'){
   if(!entry.run||entry.run.id!==id(params.runId))throw new Error('Run identity mismatch')
   const pending=entry.run.done
   entry.handle.agent.cancel({kind:'user'})
   await pending
   await client.operation({op:'barrier'})
   return {cancelled:true,quiescent:true}
  }
  if(method==='session/read'){
   await checkpoint(entry.handle.agent.session)
   const cursor=params.cursor??0
   if(typeof cursor!=='number'||!Number.isSafeInteger(cursor)||cursor<0)throw new Error('Invalid cursor')
   const handle=await ctx.sessionPersistence.open(entry.handle.agent.session.id,'read')
   try {
    const result=await handle.read(cursor,64)
    const events=[]
    let bytes=128
    for(const event of result.events){
     const n=Buffer.byteLength(JSON.stringify(event))+1
     if(n>config.maxEventBytes)throw new Error('SESSION_EVENT_BYTES_LIMIT')
     if(bytes+n>config.maxReadBytes)break
     events.push(event);bytes+=n
    }
    return {events,nextCursor:cursor+events.length,durable:true}
   }finally{await handle.close()}
  }
  throw new Error('Unknown school method')
 }
 ctx.on('llm/stream',(options,next)=>(async function*(){
  if(options.sessionId===undefined)throw new Error('Model call has no owned session')
  const session=ctx.sessions.get(options.sessionId)
  if(!session)throw new Error('Missing live session')
  await checkpoint(session)
  yield* next()
 })())
 ctx.on('tools/execute',async(exec,next)=>{
  if(!exec.agent)throw new Error('Tool has no owned agent')
  await checkpoint(exec.agent.session)
  return next()
 })
 ctx.on('agent/pre-step',async({agent,step},next)=>{
  if(step>config.maxSteps)throw new Error('STEP_LIMIT')
  await bounded(agent.session.id,true)
  return next()
 })
 ctx.on('agent/error',({agent,error})=>{
  const entry=entries.get(String(agent.session.id))
  if(entry)entry.error=error instanceof Error?error.message:String(error)
 })
 ctx.on('agent/assistant-stream',({agent,frame})=>{
  const entry=entries.get(String(agent.session.id))
  if(entry?.run)transport.notify('session.delta',{sessionId:String(agent.session.id),runId:entry.run.id,durable:false,frame})
 })
 ctx.on('session/event',(session,event)=>{
  if(Buffer.byteLength(JSON.stringify(event))>config.maxEventBytes){
   ctx.agents.get(session.id)?.cancel({kind:'user'})
   throw new Error('SESSION_EVENT_BYTES_LIMIT')
  }
 })
 transport.onRequest((method,params)=>{
  const work=serial.then(()=>request(method,params))
  serial=work.then(()=>{},()=>{})
  return work
 })
 ctx.effect(()=>{
  transport.start()
  return async()=>{
   transport.close();process.stdin.unpipe(input)
   for(const entry of entries.values())entry.handle.agent.cancel({kind:'user'})
   await Promise.allSettled([...entries.values()].map(e=>e.run?.done))
   for(const entry of entries.values())await entry.handle.dispose()
   entries.clear()
   await client.operation({op:'barrier'})
  }
 })
}
