/** Real DeepSeek through authenticated AF_UNIX; only the gateway ever sees the API key. */
import type {Context} from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {LlmAdapter,LlmError,ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import type {GenerateOptions,LlmResolvedModelInfo,StreamChunk} from '@deepseek-ai/dsh-llm'
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek'
import {readFileSync} from 'node:fs'
import http from 'node:http'
import {Readable} from 'node:stream'
import {randomUUID} from 'node:crypto'
import {serialize,parseSse,translate} from './deepseek-codec.js'
export const name='school-deepseek'
export const inject=['llm']
export interface Config {credentialId:number;socketPath:string;capabilityFile:string;maxTokens:number}
export const Config:Schema<Config>=Schema.object({
 credentialId:Schema.number().step(1).min(20).max(27).default(20),
 socketPath:Schema.string().default('/model/gateway.sock'),
 capabilityFile:Schema.string().default('/model-capability'),
 maxTokens:Schema.number().step(1).min(1).max(65536).default(65536),
})
class SchoolDeepSeek extends LlmAdapter {
 private readonly capability:string
 constructor(private readonly config:Config){super();this.capability=readFileSync(config.capabilityFile,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(this.capability))throw new Error('Invalid model capability')}
 async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{
  if(provider!=='school-deepseek'||model!=='deepseek-flash')throw new LlmError('School route unavailable','INVALID_REQUEST')
  return {provider,id:model,name:'DeepSeek Flash via bounded gateway',context:{contextWindow:1048576},defaultMaxTokens:this.config.maxTokens,reasoning:{efforts:['off','low','high','max'].map(id=>({id:ReasoningEffortId(id),name:id})),defaultEffort:ReasoningEffortId('off')}}
 }
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  await this.resolveModel(options.provider,options.model)
  const connection=resolveAdapterOptions({thinking:'enabled',reasoningEffort:'off',maxTokens:this.config.maxTokens,models:[{id:'deepseek-flash',contextWindow:1048576,maxTokens:this.config.maxTokens}],retryPolicy:{mode:'normal',maxRetries:0}})
  const body=JSON.stringify(serialize({...options,reasoningEffort:options.reasoningEffort??ReasoningEffortId('off'),maxTokens:Math.min(options.maxTokens??this.config.maxTokens,this.config.maxTokens)},connection,options.messages,new Map(),()=>undefined))
  if(Buffer.byteLength(body)>524288)throw new LlmError('School model request exceeds 512 KiB','INVALID_REQUEST')
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(1200000)]):AbortSignal.timeout(1200000)
  const request=http.request({socketPath:this.config.socketPath,path:'/v1/messages',method:'POST',signal,headers:{
   Authorization:'Bearer '+this.capability,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),
   'X-Vibe-Credential':String(this.config.credentialId),'X-Vibe-Request-Id':randomUUID(),
  }})
  request.end(body)
  let response:http.IncomingMessage|undefined
  try{
   response=await new Promise<http.IncomingMessage>((resolve,reject)=>{request.once('response',resolve);request.once('error',reject)})
   if(response.statusCode!==200){
    const chunks:Buffer[]=[];let n=0
    for await(const p of response){n+=p.length;if(n>4096)throw new LlmError('Gateway error overflow','TRANSPORT');chunks.push(Buffer.from(p))}
    let code='GATEWAY_REJECTED'
    try{const decoded:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(decoded&&typeof decoded==='object'&&'error' in decoded&&typeof decoded.error==='string'&&/^[A-Z][A-Z0-9_]+$/.test(decoded.error))code=decoded.error}catch(_malformedGatewayError){/* Status remains authoritative. */}
    throw new LlmError('School gateway: '+code,code==='TOKEN_BUDGET_EXHAUSTED'?'QUOTA':'INVALID_REQUEST')
   }
   const web=Readable.toWeb(response) as ReadableStream<BufferSource>
   yield* translate(parseSse(web,()=>{}),options.model)
  }catch(error){
   if(options.signal?.aborted)throw new LlmError('School model request cancelled','ABORTED')
   if(error instanceof LlmError)throw error
   throw new LlmError('School model gateway transport failed','TRANSPORT')
  }finally{response?.destroy();request.destroy()}
 }
}
export function apply(ctx:Context,config:Config):void{ctx.llm.registerAdapter(['school-deepseek'],new SchoolDeepSeek(config))}
