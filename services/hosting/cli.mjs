/** Root-only canary coordinator. Never used as a browser command endpoint. */
import {openControl,start,requestStop,releaseAfterStop,authorizeExecution} from './control/index.mjs'
import {publishStatus} from './status.mjs'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
function systemctl(...args){const r=spawnSync('/usr/bin/systemctl',args,{encoding:'utf8',timeout:12000});if(r.status!==0)throw new Error(r.stderr||'systemctl failed')}
const [action,rawProject,rawSlot]=process.argv.slice(2)
if(process.getuid()!==0)throw new Error('Root administration required')
const db=openControl('/var/lib/vibe-os/poc-control/control.sqlite')
const user='poc-student'
const number=Number(rawProject)
const project='demo'+number
function unit(){return 'vibe-os-poc-app'+number+'.service'}
async function stop(){
 const row=db.prepare('SELECT * FROM hosting_slots WHERE user_id=? AND project_id=?').get(user,project)
 if(!row)throw new Error('Project is not occupying a slot')
 requestStop(db,user,row.slot_no,row.generation)
 systemctl('disable','--now',unit())
 const group='/sys/fs/cgroup/system.slice/'+unit()
 let empty=false
 for(let i=0;i<100;i++){
  try{empty=readFileSync(group+'/cgroup.events','utf8').includes('populated 0\n')}
  catch(error){if(error.code==='ENOENT')empty=true;else throw error}
  if(empty)break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 if(!empty)throw new Error('Cgroup cleanup not acknowledged; slot remains held')
 releaseAfterStop(db,user,row.slot_no,row.generation,{projectId:project,generation:row.generation,rangeId:unit()+':'+row.generation,cgroupEmpty:true})
}
try{
 if(action==='status'){
  console.log(JSON.stringify(db.prepare('SELECT * FROM hosting_slots WHERE user_id=? ORDER BY slot_no').all(user),null,2))
 }else{
  if(!Number.isInteger(number)||number<1||number>4)throw new Error('Use a canary project 1..4')
  if(action==='enable'){
   const slot=Number(rawSlot)
   if(!Number.isInteger(slot)||slot<1||slot>3)throw new Error('Use a slot 1..3')
   start(db,user,slot,project,'demo-r'+number,'demo-g'+number,db.prepare('SELECT generation FROM hosting_slots WHERE user_id=? AND slot_no=?').get(user,slot).generation)
   try{
    systemctl('enable','--now',unit())
    await new Promise(resolve=>setTimeout(resolve,300))
    systemctl('is-active',unit())
    db.prepare("UPDATE hosting_slots SET observed='running' WHERE user_id=? AND project_id=?").run(user,project)
   }catch(error){
    db.prepare("UPDATE hosting_slots SET observed='failed' WHERE user_id=? AND project_id=?").run(user,project)
    throw error
   }
  }else if(action==='disable'){await stop()}
  else if(action==='restrict'){
   db.prepare("INSERT INTO deployment_restrictions(project_id,active,reason) VALUES(?,1,'operator emergency stop') ON CONFLICT(project_id) DO UPDATE SET active=1,version=version+1").run(project)
   if(db.prepare('SELECT 1 FROM hosting_slots WHERE user_id=? AND project_id=?').get(user,project))await stop()
  }else if(action==='unrestrict'){db.prepare('UPDATE deployment_restrictions SET active=0,version=version+1 WHERE project_id=?').run(project)}
  else throw new Error('Use status, enable, disable, restrict or unrestrict')
 }
}finally{publishStatus(db);db.close()}
