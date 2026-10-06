#!/usr/bin/env python3
"""Small paid Harness cycle. Operator must inspect the persistent budget before each explicit run."""
import subprocess,json,threading,queue,uuid,time
from pathlib import Path
def budget():
 result=subprocess.check_output(['node','/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs','status'],text=True)
 return json.loads(result)['budget']
def launch(sid,resume=False):
 unit='vibe-poc-live-'+uuid.uuid4().hex+'.service'
 command=['systemd-run','--quiet','--collect','--pipe','--wait','--service-type=exec','--unit='+unit,'-p','MemoryMax=512M','-p','MemorySwapMax=0','-p','TasksMax=64','-p','CPUQuota=100%','-p','RuntimeMaxSec=90s','-p','KillMode=control-group','/opt/vibe-os/bin/nsjail','--quiet','--config','/etc/vibe-os/engine-live.cfg','--','/usr/bin/node','/opt/vibe-os/build/deepseek-harness/apps/cli/lib/bin.js','--profile','school-live']
 process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 messages=queue.Queue();stderr=bytearray();frames=[];counter=0
 def output():
  for line in process.stdout:
   try:messages.put(json.loads(line))
   except Exception:messages.put({'invalid':True})
  messages.put({'eof':True})
 def errors():
  while part:=process.stderr.read(4096):
   stderr.extend(part)
   if len(stderr)>65536:del stderr[:-65536]
 threading.Thread(target=output,daemon=True).start();threading.Thread(target=errors,daemon=True).start()
 def receive(predicate,seconds=70):
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   frame=messages.get(timeout=max(.01,end-time.monotonic()))
   if frame.get('eof'):raise RuntimeError('Engine ended: '+stderr.decode(errors='replace')[:1000])
   frames.append(frame)
   if predicate(frame):return frame
  raise TimeoutError('Live Harness timed out')
 def request(method,params):
  nonlocal counter
  counter+=1
  process.stdin.write((json.dumps({'jsonrpc':'2.0','id':counter,'method':method,'params':params})+'\n').encode());process.stdin.flush()
  frame=receive(lambda f:f.get('id')==counter,15)
  if 'error' in frame:raise RuntimeError(frame['error'])
  return frame['result']
 try:
  assert request('initialize',{'provider':'school-deepseek','model':'deepseek-flash'})['paidCalls']
  opened=request('session/open',{'sessionId':sid});assert opened['resumed'] is resume
  if not resume:
   run='live-proof-'+uuid.uuid4().hex
   request('session/prompt',{'sessionId':sid,'runId':run,'text':'Call poc_pipeline exactly once with {"marker":"HARNESS_THREE_SEAMS_OK"}. After it succeeds, answer exactly HARNESS_LIVE_OK. Do not call other tools.'})
   settled=receive(lambda f:f.get('method')in['session.settled','session.failure']and f.get('params',{}).get('runId')==run)
   if 'error' in settled['params']:raise RuntimeError(settled['params']['error'])
   assert settled['params'].get('durable') and settled['params'].get('quiescent'),settled
  read=request('session/read',{'sessionId':sid,'cursor':0})
  assert any(e.get('type')=='tool/result' and 'HARNESS_THREE_SEAMS_OK' in json.dumps(e) for e in read['events']),'Missing real tool result'
  assert 'HARNESS_LIVE_OK' in json.dumps(read),'Missing live model reply'
  assert any(e.get('type')=='assistant/message' and e.get('data',{}).get('usage',{}).get('totalTokens',0)>0 for e in read['events']),'Missing durable usage'
  request('shutdown',{});assert process.wait(timeout=8)==0
  return {'resumed':resume,'eventCount':len(read['events']),'cursor':read['nextCursor'],'streamFrames':sum(f.get('method')=='session.delta'for f in frames),'usageTokens':sum(e.get('data',{}).get('usage',{}).get('totalTokens',0) for e in read['events'] if e.get('type')=='assistant/message'),'stderr':stderr.decode(errors='replace')}
 except Exception:
  print('LIVE_ENGINE_DIAGNOSTICS '+stderr.decode(errors='replace')[:6000])
  raise
 finally:
  if process.poll() is None:
   subprocess.run(['systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   process.kill();process.wait()
if __name__=='__main__':
 before=budget();results=[];sid='live-proof-'+uuid.uuid4().hex
 if before['maxRemainingCalls']<4:raise SystemExit('INSUFFICIENT_RESERVED_HEADROOM')
 try:
  results.append(launch(sid))
  results.append(launch(sid,True))
  report={'suite':'real-deepseek-harness-cycle','passed':True,'sessionId':sid,'scenarios':results,'budgetBefore':before,'budgetAfter':budget()}
 except Exception as e:
  report={'suite':'real-deepseek-harness-cycle','passed':False,'sessionId':sid,'scenarios':results,'error':str(e),'budgetBefore':before,'budgetAfter':budget()}
 Path('/opt/vibe-os/platform/evidence/deepseek-harness.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
 raise SystemExit(0 if report['passed']else 1)
