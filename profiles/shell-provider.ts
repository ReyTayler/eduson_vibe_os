/** Foreground-only shell seam; every command has an enforced deadline and cgroup cleanup. */
import type { Context } from '@deepseek-ai/cordis'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type {ShellExecRequest,ShellExecSpec,ShellExecution} from '@deepseek-ai/dsh-shell'
import {RunnerClient,runResult} from './runner-client.js'
export default class SchoolShell extends ShellExecutor {
  private readonly client=new RunnerClient()
  constructor(ctx:Context){super(ctx)}
  override get sandboxMode(){return 'workspace-write' as const}
  resolve(request:ShellExecRequest):ShellExecSpec {
    if(request.onExpiry==='none'||request.stdin||request.env&&Object.keys(request.env).length||request.dshEnv&&Object.keys(request.dshEnv).length)throw new Error('Background jobs, stdin and environment overrides are disabled')
    if(request.workdir&&request.workdir!=='/workspace')throw new Error('Invalid project workdir')
    if(request.sandboxPolicy?.mode==='danger-full-access')throw new Error('Escalation is disabled')
    return {command:request.command,workdir:'/workspace',timeoutMs:Math.max(50,Math.min(3000,request.timeoutMs??2000)),onExpiry:'kill',stdoutMaxBytes:65536,signal:request.signal,sandboxPolicy:request.sandboxPolicy}
  }
  async execute(spec:ShellExecSpec):Promise<ShellExecution> {
    if(spec.onExpiry!=='kill'||spec.workdir!=='/workspace'||spec.timeoutMs>3000)throw new Error('Invalid resolved shell request')
    const controller=new AbortController(),abort=()=>controller.abort()
    spec.signal?.throwIfAborted();spec.signal?.addEventListener('abort',abort,{once:true})
    let status:'running'|'completed'|'killed'='running',exitCode:number|null=null,signal:NodeJS.Signals|null=null,output='',read=false
    const result=this.client.operation({op:'run',program:'bash',args:['-c',spec.command],timeoutMs:spec.timeoutMs},controller.signal).then(value=>{
      const r=runResult(value)
      exitCode=r.exitCode;status=r.timedOut||r.aborted?'killed':'completed'
      output=r.stdout.text+r.stderr.text
      return {exitCode:r.exitCode,signal:null,timedOut:r.timedOut,aborted:r.aborted,timeoutMs:spec.timeoutMs,stdout:r.stdout,stderr:r.stderr,sandbox:{mode:'workspace-write' as const,denied:false,enforcement:'full' as const}}
    }).finally(()=>spec.signal?.removeEventListener('abort',abort))
    const done=result.then(()=>{},()=>{status='killed'})
    return {get status(){return status},get exitCode(){return exitCode},get signal(){return signal},done,result:()=>result,kill(){if(status!=='running')return false;controller.abort();return true},readOutput(){const delta=read?'':output;read=true;return {delta,lossy:false}},observed:{stdout:{readFrom(offset){return {text:output.slice(offset),nextOffset:Buffer.byteLength(output),lossy:false}}},stderr:{readFrom(){return {text:'',nextOffset:0,lossy:false}}}}}
  }
}
