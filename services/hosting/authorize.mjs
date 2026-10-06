/** Validate the exact approved canary before every start, including reboot. */
import {publishStatus} from './status.mjs'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {openControl,authorizeExecution,restart} from './control/index.mjs'
export function digest(number){
 return createHash('sha256').update(readFileSync('/opt/vibe-os/poc-hosting/code/server.mjs'))
 .update(readFileSync('/etc/vibe-os/app-'+number+'.cfg'))
 .update(readFileSync('/etc/vibe-os/school.policy'))
 .update(createHash('sha256').update(readFileSync('/opt/vibe-os/rootfs/usr/bin/node')).digest()).digest('hex')
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const number=Number(process.argv[2])
 if(!Number.isInteger(number)||number<1||number>4)throw new Error('Invalid project')
 const db=openControl('/var/lib/vibe-os/poc-control/control.sqlite')
 try{
  const row=db.prepare("SELECT * FROM hosting_slots WHERE user_id='poc-student' AND project_id=?").get('demo'+number)
  if(!row)throw new Error('Project is not assigned to an occupied slot')
  const approved=authorizeExecution(db,'poc-student',row.slot_no)
  const release=db.prepare('SELECT content_sha FROM releases WHERE id=?').get(approved.release_id)
  if(release.content_sha!==digest(number))throw new Error('Code or sandbox profile changed; approval required')
  restart(db,'poc-student',row.slot_no,row.generation)
 }finally{publishStatus(db);db.close()}
}
