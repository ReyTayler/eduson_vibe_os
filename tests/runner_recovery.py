#!/usr/bin/env python3
import subprocess,time,json
from pathlib import Path
inside="""import socket,http.client,json,time
from pathlib import Path
class U(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(10);self.sock.connect("/bridge/runner.sock")
cap=Path("/capability").read_text().strip()
def call(body):
 c=U("localhost");c.request("POST","/v1/operation",json.dumps(body),{"Authorization":"Bearer "+cap,"Content-Type":"application/json"})
 r=c.getresponse();data=json.loads(r.read());c.close();assert r.status==200;return data
try:
 call({"op":"run","program":"python","args":["-c","import time;print('ready',flush=True);time.sleep(10)"],"timeoutMs":3000})
 print("firstCompleted",flush=True)
except Exception:
 print("firstInterrupted",flush=True)
time.sleep(3)
r=call({"op":"barrier"});assert r["result"]["cgroupEmpty"]
print("reconnected-and-quiescent",flush=True)
"""
p=subprocess.Popen(['/opt/vibe-os/bin/nsjail','--quiet','--config','/etc/vibe-os/engine.cfg','--','/usr/bin/python3.10','-u','-c',inside],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
found=False
for i in range(100):
 active=subprocess.check_output(['systemctl','list-units','--plain','--no-legend','--state=running','vibe-tool-*.service'],text=True)
 if 'vibe-tool-'in active:found=True;break
 time.sleep(.02)
assert found,'No owned workload observed'
subprocess.run(['systemctl','kill','--kill-who=main','--signal=SIGKILL','vibe-os-poc-runner'],check=True)
stdout,stderr=p.communicate(timeout=12)
assert p.returncode==0,(p.returncode,stderr.decode())
assert b'firstInterrupted'in stdout and b'reconnected-and-quiescent'in stdout,stdout
active=subprocess.check_output(['systemctl','list-units','--plain','--no-legend','--state=running','vibe-tool-*.service'],text=True)
assert not active.strip(),active
print(json.dumps({'suite':'runner-crash-recovery','passed':True,'workloadInterrupted':True,'stableBindMountReconnected':True,'ownedCgroupsEmpty':True,'engineStdout':stdout.decode()},indent=2))
