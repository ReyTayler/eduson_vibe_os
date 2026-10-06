/** Publish a small read-only operator projection; the console never opens the writable WAL database. */
import {writeFileSync,renameSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
export function publishStatus(db){
 const file='/var/lib/vibe-os/poc-control/status.json',temporary=file+'.'+randomUUID()+'.tmp'
 const slots=db.prepare("SELECT slot_no,project_id,desired,observed,generation,resource_held FROM hosting_slots WHERE user_id='poc-student' ORDER BY slot_no").all()
 writeFileSync(temporary,JSON.stringify({phase:'technical-poc',paidCalls:false,slots}),{mode:0o640})
 renameSync(temporary,file)
}
