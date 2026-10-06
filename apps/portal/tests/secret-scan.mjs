
/** Root-only scan; never prints or stores secrets. */
import {readFileSync,writeFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {Vault} from '../../../packages/credentials/vault.mjs';
const repo='/opt/vibe-os/platform',vault=new Vault(readFileSync('/etc/vibe-os/credentials/master.key'),'/var/lib/vibe-os/credentials');
const values=Array.from({length:8},(_,i)=>vault.get(i+20));
const passwords=JSON.parse(readFileSync('/var/lib/vibe-os/portal-private/student-logins.json')).map(a=>a.password);
const capabilities=['/var/lib/vibe-os/portal-private/broker-capability','/var/lib/vibe-os/portal-private/csrf-secret','/var/lib/vibe-os/poc-engine/model-capability'].map(p=>readFileSync(p,'utf8').trim());
capabilities.push(...JSON.parse(readFileSync('/etc/vibe-os/credentials/student-capabilities.json','utf8')).map(row=>row.capability));
for(const name of readdirSync('/var/lib/vibe-os/student-registry')){
 if(name.endsWith('.json')){
  const r=JSON.parse(readFileSync('/var/lib/vibe-os/student-registry/'+name));
  if(r.capability)capabilities.push(r.capability);
  if(r.token)capabilities.push(r.token);
 }
}
const needles=[...values,...passwords,...capabilities].filter(x=>typeof x==='string'&&x.length>=16).map(x=>Buffer.from(x));
const scanned={sourceFiles:0,browserArtifacts:0,harnessHistoryFiles:0,processes:0,journalBytes:0,gitHistoryBytes:0};
function scan(data,label){if(needles.some(s=>data.includes(s)))throw new Error('Secret detected in '+label)}
const files=execFileSync('runuser',['-u','vibe-build','--','git','-C',repo,'ls-files','--cached','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean);
for(const rel of new Set(files)){const p=repo+'/'+rel;if(lstatSync(p).isFile()){scan(readFileSync(p),rel);scanned.sourceFiles++}}
function walk(dir,callback){
 for(const name of readdirSync(dir)){const p=dir+'/'+name,stat=lstatSync(p);if(stat.isDirectory())walk(p,callback);else if(stat.isFile())callback(p)}
}
walk('/opt/vibe-os/portal/web',p=>{scan(readFileSync(p),'browser artifact');scanned.browserArtifacts++});
walk('/srv/vibe-os/data/student-projects',p=>{if(p.endsWith('.jsonl')||p.endsWith('.log')){scan(readFileSync(p),'Harness history');scanned.harnessHistoryFiles++}});
const history=execFileSync('runuser',['-u','vibe-build','--','git','-C',repo,'log','--all','--format=','-p'],{maxBuffer:64*1024*1024});scan(history,'Git history');scanned.gitHistoryBytes=history.length;
const journal=execFileSync('journalctl',['--since','2026-10-06 00:00:00','--no-pager','-o','cat','-u','vibe-os-portal.service','-u','vibe-os-workspace-broker.service','-u','vibe-os-workspace-runner.service','-u','vibe-os-model-gateway.service'],{maxBuffer:64*1024*1024});scan(journal,'service journal');scanned.journalBytes=journal.length;
for(const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))){
 try{scan(readFileSync('/proc/'+pid+'/cmdline'),'process arguments');scan(readFileSync('/proc/'+pid+'/environ'),'process environment');scanned.processes++}catch(e){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code))throw e}
}
const report={passed:true,timeUtc:new Date().toISOString(),actualApiKeysChecked:values.length,passwordsChecked:passwords.length,capabilitiesChecked:capabilities.length,scanned};
writeFileSync(repo+'/evidence/student-secret-scan.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
