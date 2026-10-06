/** Publish running only after the private service actually responds. */
import http from 'node:http'
import {openControl} from './control/index.mjs'
import {publishStatus} from './status.mjs'
const number=Number(process.argv[2])
if(!Number.isInteger(number)||number<1||number>4)throw new Error('Invalid project')
let ready=false
for(let attempt=0;attempt<40;attempt++){
 ready=await new Promise(resolve=>{
  const req=http.get({socketPath:'/run/vibe-os-poc-app'+number+'/http.sock',path:'/'},res=>{res.resume();resolve(res.statusCode===200)})
  req.setTimeout(300,()=>req.destroy());req.on('error',()=>resolve(false))
 })
 if(ready)break
 await new Promise(resolve=>setTimeout(resolve,50))
}
if(!ready)throw new Error('Hosted service did not become ready')
const db=openControl('/var/lib/vibe-os/poc-control/control.sqlite')
try{db.prepare("UPDATE hosting_slots SET observed='running' WHERE user_id='poc-student' AND project_id=? AND desired='on'").run('demo'+number);publishStatus(db)}finally{db.close()}
