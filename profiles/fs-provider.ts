/** Filesystem service over an anchored project root. Binary/image operations are disabled in this PoC. */
import type { Context } from '@deepseek-ai/cordis'
import FileSystem, { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsInfo, FsPathInfo, FsDirEntry, FsWriteIntent, FsWriteOutcome, FsEditRequest, FsEditOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import posix from 'node:path/posix'
import { RunnerClient, object, text } from './runner-client.js'
function pathOf(p:string,cwd='/workspace'):string {
  const result=posix.isAbsolute(p)?posix.normalize(p):posix.resolve(cwd,p)
  if(result!=='/workspace'&&!result.startsWith('/workspace/')) throw new FsError('Path is outside the project','FS_SANDBOX_DENIED')
  return result
}
function info(value:unknown):FsInfo|undefined {
  if(value===null)return undefined
  const v=object(value)
  if(!['file','directory','other'].includes(text(v.type))||typeof v.size!=='number') throw new Error('Invalid file metadata')
  const kind=v.type==='file'?'file':v.type==='directory'?'directory':'other'
  return {type:kind,size:v.size,version:FsVersion(text(v.version))}
}
function mutation(value:unknown):FsWriteOutcome {
  const v=object(value)
  if(v.operation!=='create'&&v.operation!=='update')throw new Error('Invalid file mutation')
  return {operation:v.operation,version:FsVersion(text(v.version)),before:v.before===null?null:text(v.before),after:text(v.after)}
}
function writable(policy?:SandboxExecutionPolicy):void {
  if(policy?.mode==='read-only'||policy?.mode==='danger-full-access') throw new FsError('This operation is unavailable in this profile','FS_SANDBOX_DENIED')
}
export default class SchoolFileSystem extends FileSystem {
  private readonly client=new RunnerClient()
  constructor(ctx:Context){super(ctx)}
  override get sandboxMode(){return 'workspace-write' as const}
  async resolve(p:string,opts?:{cwd?:string;signal?:AbortSignal}):Promise<FsTarget>{
    opts?.signal?.throwIfAborted()
    const name=pathOf(p,opts?.cwd)
    return {targetKey:FsTargetKey(name),displayPath:name}
  }
  processPath(t:FsTarget):string{return pathOf(t.displayPath)}
  fileUrl(t:FsTarget):string{return 'file://'+encodeURI(this.processPath(t))}
  contains(parent:FsTarget,child:FsTarget):boolean{
    const p=this.processPath(parent),c=this.processPath(child)
    return c===p||c.startsWith(p+'/')
  }
  async stat(t:FsTarget,signal?:AbortSignal):Promise<FsInfo|undefined>{return info(await this.client.operation({op:'stat',path:this.processPath(t)},signal))}
  async lstat(p:string,opts?:{cwd?:string},signal?:AbortSignal):Promise<FsPathInfo|undefined>{
    return this.stat(await this.resolve(p,opts),signal)
  }
  async readText(t:FsTarget,signal?:AbortSignal):Promise<string>{
    return text(object(await this.client.operation({op:'read',path:this.processPath(t)},signal)).text)
  }
  async streamText(t:FsTarget,signal?:AbortSignal):Promise<AsyncIterable<string>>{
    const value=await this.readText(t,signal)
    return (async function*(){for(let i=0;i<value.length;i+=16384){signal?.throwIfAborted();yield value.slice(i,i+16384)}})()
  }
  async readBytes(_t:FsTarget,_signal:AbortSignal|undefined,_maxBytes:number):Promise<Uint8Array>{
    throw new FsError('Binary files are disabled in this prototype','FS_NOT_TEXT')
  }
  async readByteRange(_t:FsTarget,_range:{offset:number;length:number},_signal?:AbortSignal):Promise<Uint8Array>{
    throw new FsError('Binary files are disabled in this prototype','FS_NOT_TEXT')
  }
  async listDir(t:FsTarget,signal?:AbortSignal):Promise<FsDirEntry[]>{
    const values=await this.client.operation({op:'list',path:this.processPath(t)},signal)
    if(!Array.isArray(values))throw new Error('Invalid file listing')
    const result:FsDirEntry[]=[]
    for(const value of values){
      const v=object(value),name=text(v.name),s=info(v.info)
      if(!s)throw new Error('Invalid listing entry')
      result.push({name,type:s.type,version:s.version,size:s.size,target:await this.resolve(name,{cwd:this.processPath(t)})})
    }
    return result.sort((a,b)=>a.name.localeCompare(b.name))
  }
  async writeText(t:FsTarget,content:string,expected?:FsWriteIntent,signal?:AbortSignal,policy?:SandboxExecutionPolicy):Promise<FsWriteOutcome>{
    writable(policy)
    return mutation(await this.client.operation({op:'write',path:this.processPath(t),text:content,...expected?{guard:expected}:{}},signal))
  }
  async editText(t:FsTarget,edit:FsEditRequest,expected?:{version:FsVersion},signal?:AbortSignal,policy?:SandboxExecutionPolicy):Promise<FsEditOutcome>{
    writable(policy)
    const result=mutation(await this.client.operation({op:'edit',path:this.processPath(t),old:edit.oldString,new:edit.newString,replaceAll:edit.replaceAll,...expected?{guard:{kind:'replaceIfVersion',...expected}}:{}},signal))
    if(result.before===null)throw new Error('Edit basis missing')
    return {version:result.version,before:result.before,after:result.after}
  }
}
