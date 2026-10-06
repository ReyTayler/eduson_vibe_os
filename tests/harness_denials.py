#!/usr/bin/env python3
import subprocess,json,uuid,threading,queue,time
from pathlib import Path
BASE=['/opt/vibe-os/bin/nsjail','--quiet','--config','/etc/vibe-os/engine.cfg','--']
CLI=BASE+['/usr/bin/node','/opt/vibe-os/build/deepseek-harness/apps/cli/lib/bin.js','--profile','school-poc']
cases=[]
def test(name,fn):
 try:cases.append({'name':name,'passed':True,'detail':fn()})
 except Exception as e:cases.append({'name':name,'passed':False,'error':str(e)})
def engine_isolation():
 code='import os,socket,errno,json\nfrom pathlib import Path\nassert os.getuid()==1000\nassert not Path("/root/.ssh").exists()\nassert not Path("/var/lib/vibe-os/poc-control/control.sqlite").exists()\nassert not Path("/srv/vibe-os/data/poc-project-2").exists()\nfor family in (socket.AF_INET,socket.AF_INET6):\n try: socket.socket(family,socket.SOCK_STREAM)\n except OSError as e: assert e.errno==errno.EPERM\n else: raise AssertionError("INET allowed")\nprint("engine-filesystem-and-egress-isolated")'
 p=subprocess.run(BASE+['/usr/bin/python3.10','-c',code],capture_output=True,text=True,timeout=5)
 assert p.returncode==0,p.stderr
 return {'uid1000':True,'noHostData':True,'INETDenied':True,'INET6Denied':True}
test('engine itself cannot read host data or create Internet sockets',engine_isolation)
class Session:
 def __init__(self):
  self.proc=subprocess.Popen(CLI,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  self.queue=queue.Queue();self.i=0
  def reader():
   for line in iter(self.proc.stdout.readline,b''):
    try:self.queue.put(json.loads(line))
    except Exception:pass
   self.queue.put({'eof':True})
  threading.Thread(target=reader,daemon=True).start()
 def request(self,method,params):
  self.i+=1
  self.proc.stdin.write((json.dumps({'jsonrpc':'2.0','id':self.i,'method':method,'params':params})+'\n').encode());self.proc.stdin.flush()
  end=time.monotonic()+8
  while time.monotonic()<end:
   frame=self.queue.get(timeout=max(.05,end-time.monotonic()))
   if frame.get('eof'):raise RuntimeError('Engine EOF: '+self.proc.stderr.read().decode(errors='replace')[-2000:])
   if frame.get('id')==self.i:return frame
  raise TimeoutError()
 def close(self):
  self.proc.stdin.close()
  try:self.proc.wait(timeout=5)
  except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
def reject_real_provider():
 s=Session()
 try:
  frame=s.request('initialize',{'provider':'deepseek-official','model':'deepseek-flash'})
  assert 'error'in frame and 'keyless'in frame['error']['message'],frame
  return {'noFallback':True,'paidCalls':0}
 finally:s.close()
test('real model route cannot trigger SDK fallback',reject_real_provider)
def prompt_limit():
 s=Session()
 try:
  assert 'result'in s.request('initialize',{'provider':'school-mock','model':'poc-fixed'})
  sid='negative-'+uuid.uuid4().hex
  assert 'result'in s.request('session/open',{'sessionId':sid})
  frame=s.request('session/prompt',{'sessionId':sid,'runId':'limit','text':'x'*8193})
  assert 'error'in frame and 'PROMPT_LIMIT'in frame['error']['message'],frame
  return {'8193BytePromptRejected':True}
 finally:s.close()
test('oversized prompt is rejected before model dispatch',prompt_limit)
def history_limit():
 home=Path('/srv/vibe-os/data/poc-engine-1/sessions/--workspace--')
 originals=list(home.glob('poc-*/session.v*.jsonl'))
 assert originals
 header=json.loads(originals[-1].open().readline())
 sid='oversize-'+uuid.uuid4().hex
 if 'id'in header:header['id']=sid
 if isinstance(header.get('meta'),dict):header['meta']['id']=sid
 if isinstance(header.get('header'),dict):header['header']['id']=sid
 directory=home/sid;directory.mkdir(mode=0o700)
 import os
 os.chown(directory,23000,23000)
 file=directory/originals[-1].name
 try:
  with file.open('wb') as out:
   out.write((json.dumps(header)+'\n').encode());out.write(b'X'*(8*1024**2))
  os.chown(file,23000,23000)
  s=Session()
  try:
   assert 'result'in s.request('initialize',{'provider':'school-mock','model':'poc-fixed'})
   frame=s.request('session/open',{'sessionId':sid})
   assert 'error'in frame and 'SESSION_HISTORY_LIMIT'in frame['error']['message'],frame
   return {'over8MiBRejectedBeforeDecode':True}
  finally:s.close()
 finally:file.unlink();directory.rmdir()
test('cold history limit is checked before event decoding',history_limit)
def frame_limit():
 p=subprocess.Popen(CLI,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  p.stdin.write(b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"'+b'x'*66000+b'"}}\n');p.stdin.flush()
  code=p.wait(timeout=6)
  assert code!=0,code
  return {'over64KiBFrameRejected':True,'exitCode':code}
 finally:
  if p.poll() is None:p.kill();p.wait()
test('oversized wire frame terminates the private runtime',frame_limit)
print(json.dumps({'suite':'school-protocol-and-engine-denials','cases':cases,'passed':sum(c['passed'] for c in cases),'total':len(cases)},indent=2))
raise SystemExit(0 if all(c['passed'] for c in cases) else 1)
