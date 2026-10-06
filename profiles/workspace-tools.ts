/** Student workspace tools; capabilities and process isolation are enforced by Runner. */
import type {Context} from '@deepseek-ai/cordis'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {RunnerClient,object,text} from './runner-client.js'
export const name='student-workspace-tools'
export const inject=['tools']
export function apply(ctx:Context):void{
 const client=new RunnerClient()
 const output={schema:{type:'string' as const},render:(_args:object,value:string)=>[{type:'text' as const,text:value}]}
 ctx.tools.register(defineTool({name:'read_file',description:'Read a text file in this project. Paths are relative to /workspace; offset is a one-based line number, limit is at most 200 lines.',parameters:{path:{type:'string',required:true},offset:{type:'number'},limit:{type:'number'}},output,
  async execute(args,exec){const result=object(await client.operation({op:'read',path:args.path},exec.signal));const lines=text(result.text).split('\n');const start=Math.max(0,Math.floor(args.offset??1)-1),limit=Math.min(200,Math.max(1,Math.floor(args.limit??120)));return JSON.stringify({path:args.path,version:object(result.info).version,totalLines:lines.length,text:lines.slice(start,start+limit).join('\n').slice(0,8192)})}}))
 ctx.tools.register(defineTool({name:'write_file',description:'Create or replace a UTF-8 file in this project. Create parent directories with create_directory first. Only this project is writable.',parameters:{path:{type:'string',required:true},content:{type:'string',required:true}},output,
  async execute(args,exec){if(Buffer.byteLength(args.content)>131072)throw new Error('FILE_CONTENT_LIMIT');const result=object(await client.operation({op:'write',path:args.path,text:args.content},exec.signal));return JSON.stringify({path:args.path,operation:result.operation,version:result.version})}}))
 ctx.tools.register(defineTool({name:'edit_file',description:'Replace an exact occurrence in a text file. An ambiguous match is rejected unless replaceAll is true.',parameters:{path:{type:'string',required:true},oldText:{type:'string',required:true},newText:{type:'string',required:true},replaceAll:{type:'boolean'}},output,
  async execute(args,exec){const result=object(await client.operation({op:'edit',path:args.path,old:args.oldText,new:args.newText,replaceAll:args.replaceAll??false},exec.signal));return JSON.stringify({path:args.path,version:result.version})}}))
 ctx.tools.register(defineTool({name:'list_directory',description:'List files and directories in this project. Use . for the project root.',parameters:{path:{type:'string',required:true}},output,
  async execute(args,exec){return JSON.stringify(await client.operation({op:'list',path:args.path},exec.signal)).slice(0,8192)}}))
 ctx.tools.register(defineTool({name:'create_directory',description:'Create one directory inside this project. Parent must already exist.',parameters:{path:{type:'string',required:true}},output,
  async execute(args,exec){await client.operation({op:'mkdir',path:args.path},exec.signal);return JSON.stringify({path:args.path,created:true})}}))
 ctx.tools.register(defineTool({name:'run_command',description:'Run bash, Python 3.10, Node 24 or ripgrep in this project. Maximum duration 3 seconds, no network and no background jobs. Use python3.10 or node for programs. Do not start a web server: HTML is previewed and hosted through the platform.',parameters:{command:{type:'string',required:true}},output,
  async execute(args,exec){if(Buffer.byteLength(args.command)>8192)throw new Error('COMMAND_LIMIT');const result=object(await client.operation({op:'run',program:'bash',args:['-c',args.command],timeoutMs:3000},exec.signal));return JSON.stringify({exitCode:result.exitCode,timedOut:result.timedOut,stdout:text(object(result.stdout).text).slice(-4096),stderr:text(object(result.stderr).text).slice(-4096)})}}))
}
