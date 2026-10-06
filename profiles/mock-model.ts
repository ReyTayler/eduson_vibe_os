/** Keyless scripted model for real profile composition tests. It never opens an Internet connection. */
import type {Context} from '@deepseek-ai/cordis'
import {LlmAdapter,ToolCallId} from '@deepseek-ai/dsh-llm'
import type {GenerateOptions,LlmResolvedModelInfo,StreamChunk} from '@deepseek-ai/dsh-llm'
import {defineTool} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-subprocess'
class SchoolMock extends LlmAdapter {
  async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{
    if(provider!=='school-mock'||model!=='poc-fixed')throw new Error('Only the keyless PoC model is available')
    return {provider,id:model,name:'PoC scripted model',context:{contextWindow:32768}}
  }
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
    const user=options.messages.filter(m=>m.role==='user').at(-1)
    if(JSON.stringify(user).includes('wait-for-cancel')){
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'text-delta',index:0,text:'Waiting for cancellation'}
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(resolve,5000)
        options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('Mock cancelled'))},{once:true})
      })
    }
    const last=options.messages.at(-1)
    if(last?.role==='tool'&&last.isError){yield {type:'finish',reason:{kind:'error',failure:{code:'SERVER',message:'PoC pipeline failed'}}};return}
    if(last?.role!=='tool'){
      const args=JSON.stringify({marker:'HARNESS_THREE_SEAMS_OK'})
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'tool-call-delta',index:0,id:ToolCallId('poc-pipeline-call'),name:'poc_pipeline',argumentsDelta:args}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('poc-pipeline-call'),name:'poc_pipeline',arguments:args}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
      return
    }
    const reply='School profile completed through anchored FS, jailed ripgrep and jailed bash.'
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'text-delta',index:0,text:reply}
    yield {type:'block-end',index:0,block:{type:'text',text:reply}}
    yield {type:'usage',usage:{inputTokens:20,outputTokens:10}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}
export const name='school-mock'
export const inject=['llm','tools','fs','shell','subprocess']
export function apply(ctx:Context):void{
  ctx.llm.registerAdapter(['school-mock'],new SchoolMock())
  ctx.tools.register(defineTool({
    name:'poc_pipeline',
    description:'Write a marker file, find it, and run a short program in the project.',
    parameters:{marker:{type:'string',required:true}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args,exec){
      if(args.marker!=='HARNESS_THREE_SEAMS_OK')throw new Error('Unexpected fixture marker')
      const target=await ctx.fs.resolve('harness-proof.txt')
      await ctx.fs.writeText(target,args.marker+'\n',undefined,exec.signal)
      const observed=await ctx.fs.readText(target,exec.signal)
      const rg=ctx.subprocess.spawn({argv:[await ctx.subprocess.resolveExecutable('rg'),args.marker,'/workspace/harness-proof.txt'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:{maxBytes:65536},stderr:{maxBytes:65536}},graceMs:100,signal:exec.signal})
      const done=await rg.done
      const search=rg.collected.stdout?.readFrom(0).text
      if(done.exitCode!==0||!search?.includes(args.marker))throw new Error('Jailed direct subprocess failed')
      const shell=await ctx.shell.execute(ctx.shell.resolve({command:'python3.10 -c "import os; assert os.getuid()==1000; print(open(\'harness-proof.txt\').read().strip())"',signal:exec.signal}))
      const result=await shell.result()
      if(result.exitCode!==0||!result.stdout.text.includes(args.marker)||observed.trim()!==args.marker)throw new Error('Jailed shell failed')
      return 'HARNESS_THREE_SEAMS_OK'
    },
  }))
}
