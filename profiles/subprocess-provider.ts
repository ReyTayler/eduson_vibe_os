/** Only the pinned jail ripgrep is admitted through the direct subprocess seam. */
import type { Context } from '@deepseek-ai/cordis'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec,SubprocessHandle,SubprocessOutputReader,SubprocessTerminalEnvironment,SubprocessTerminalSpawnSpec,SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { PassThrough } from 'node:stream'
import { RunnerClient,runResult } from './runner-client.js'
function reader():SubprocessOutputReader&{set(t:string,lossy:boolean):void}{
  let value='',lost=false
  return {set(t,l){value=t;lost=l},readFrom(offset){const b=Buffer.from(value);return {text:b.subarray(Math.min(offset,b.length)).toString('utf8'),nextOffset:b.length,lossy:lost}}}
}
export default class SchoolSubprocess extends SubprocessRuntime {
  private readonly client=new RunnerClient()
  private readonly operations=new Set<Promise<unknown>>()
  constructor(ctx:Context){
    super(ctx)
    ctx.effect(()=>async()=>{await Promise.allSettled([...this.operations]);await this.client.operation({op:'barrier'})})
  }
  async resolveExecutable(command:string,_env?:Readonly<Record<string,string>>,signal?:AbortSignal):Promise<string>{
    signal?.throwIfAborted()
    if(command!=='rg'&&command!=='/usr/bin/rg')throw new Error('Executable is unavailable in this profile')
    return '/usr/bin/rg'
  }
  async terminalEnvironment():Promise<SubprocessTerminalEnvironment>{return {platform:'posix',defaultShell:'/bin/bash'}}
  async spawnTerminal(_spec:SubprocessTerminalSpawnSpec):Promise<SubprocessTerminalHandle>{throw new Error('PTY is disabled in this profile')}
  spawn(spec:SubprocessSpawnSpec):SubprocessHandle{
    spec.signal?.throwIfAborted()
    if(spec.argv[0]!=='/usr/bin/rg'||spec.cwd!=='/workspace'||spec.stdio.stdin!=='ignore'||spec.stdio.control||spec.stdio.stdout==='inherit'||spec.stdio.stderr==='inherit')throw new Error('Unsupported subprocess request')
    if(spec.env&&Object.keys(spec.env).length)throw new Error('Environment overrides are disabled')
    const controller=new AbortController()
    const abort=()=>controller.abort()
    spec.signal?.addEventListener('abort',abort,{once:true})
    const out=new PassThrough(),err=new PassThrough(),stdout=reader(),stderr=reader()
    const operation=this.client.operation({op:'run',program:'rg',args:spec.argv.slice(1),timeoutMs:2000},controller.signal).then(value=>{
      const r=runResult(value)
      stdout.set(r.stdout.text,r.stdout.truncated);stderr.set(r.stderr.text,r.stderr.truncated)
      out.end(r.stdout.text);err.end(r.stderr.text)
      return {exitCode:r.exitCode,signal:null}
    }).finally(()=>{spec.signal?.removeEventListener('abort',abort)})
    this.operations.add(operation)
    void operation.then(()=>this.operations.delete(operation),()=>this.operations.delete(operation))
    return {stdin:undefined,control:undefined,stdout:spec.stdio.stdout==='pipe'?out:undefined,stderr:spec.stdio.stderr==='pipe'?err:undefined,collected:{stdout:typeof spec.stdio.stdout==='object'?stdout:undefined,stderr:typeof spec.stdio.stderr==='object'?stderr:undefined},done:operation,terminate(){controller.abort()},async waitForExit(signal){if(signal?.aborted)return false;await operation;return true}}
  }
}
