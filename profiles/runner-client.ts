/** Bounded authenticated RPC to the root Runner; no TCP transport is exposed. */
import { readFileSync } from 'node:fs'
import http from 'node:http'
export interface Output { text: string; totalBytes: number; truncated: boolean }
export interface RunResult { exitCode: number; timedOut: boolean; aborted: boolean; cgroupEmpty: true; stdout: Output; stderr: Output }
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Runner object')
  return value as Record<string, unknown>
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Runner text')
  return value
}
function output(value: unknown): Output {
  const v=object(value)
  if (typeof v.totalBytes!=='number'||typeof v.truncated!=='boolean') throw new Error('Invalid Runner output')
  const t=text(v.text)
  if (Buffer.byteLength(t)>65536) throw new Error('Runner capture overflow')
  return {text:t,totalBytes:v.totalBytes,truncated:v.truncated}
}
export function runResult(value: unknown): RunResult {
  const v=object(value)
  if (!Number.isInteger(v.exitCode)||typeof v.exitCode!=='number'||typeof v.timedOut!=='boolean'||typeof v.aborted!=='boolean'||v.cgroupEmpty!==true) throw new Error('Runner did not confirm quiescence')
  return {exitCode:v.exitCode,timedOut:v.timedOut,aborted:v.aborted,cgroupEmpty:true,stdout:output(v.stdout),stderr:output(v.stderr)}
}
export class RunnerClient {
  readonly socketPath: string
  private readonly token: string
  constructor(socketPath='/bridge/runner.sock',capFile='/capability') {
    this.socketPath=socketPath
    this.token=readFileSync(capFile,'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('Invalid capability')
  }
  async operation(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const bytes=JSON.stringify(body)
    if (Buffer.byteLength(bytes)>2*1024*1024) throw new Error('Runner request too large')
    return new Promise((resolve,reject)=>{
      const req=http.request({socketPath:this.socketPath,path:'/v1/operation',method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)},signal},res=>{
        const chunks: Buffer[]=[]
        let length=0
        res.on('data',(chunk: Buffer)=>{
          length+=chunk.length
          if(length>3*1024*1024){req.destroy(new Error('Runner response too large'));return}
          chunks.push(chunk)
        })
        res.on('error',reject)
        res.on('end',()=>{
          try {
            const result=object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if(res.statusCode!==200) throw new Error(text(result.error))
            if(!Object.hasOwn(result,'result')) throw new Error('Runner result missing')
            resolve(result.result)
          }catch(error){reject(error)}
        })
      })
      req.setTimeout(10000,()=>req.destroy(new Error('Runner transport deadline')))
      req.on('error',reject)
      req.end(bytes)
    })
  }
}
