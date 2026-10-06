/** Wait for the Unix listener; provider credentials are only read by ExecStart. */
import net from 'node:net'
function probe(){return new Promise(resolve=>{
 const socket=net.createConnection('/run/vibe-os-model/gateway.sock')
 socket.setTimeout(500)
 socket.once('connect',()=>{socket.destroy();resolve(true)})
 socket.once('error',()=>{socket.destroy();resolve(false)})
 socket.once('timeout',()=>{socket.destroy();resolve(false)})
})}
let ready=false
for(let i=0;i<30;i++){
 ready=await probe();if(ready)break
 await new Promise(r=>setTimeout(r,100))
}
if(!ready){console.error('GATEWAY_READINESS_FAILED');process.exitCode=1}
