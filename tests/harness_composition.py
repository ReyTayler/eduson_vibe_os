#!/usr/bin/env python3
import subprocess, json, threading, queue, time, uuid
from pathlib import Path
def run_session(sid,resume=False):
    unit='vibe-poc-engine-'+uuid.uuid4().hex+'.service'
    cmd=['systemd-run','--quiet','--pipe','--wait','--service-type=exec','--unit='+unit,
         '-p','MemoryMax=512M','-p','MemorySwapMax=0','-p','TasksMax=64','-p','CPUQuota=100%',
         '-p','RuntimeMaxSec=30s','-p','KillMode=control-group',
         '/opt/vibe-os/bin/nsjail','--quiet','--config','/etc/vibe-os/engine.cfg','--',
         '/usr/bin/node','/opt/vibe-os/build/deepseek-harness/apps/cli/lib/bin.js','--profile','school-poc']
    process=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    events=queue.Queue();stderr=bytearray();frames=[];counter=0;memory=[];stopped=threading.Event()
    def stdout():
        while True:
            line=process.stdout.readline(300000)
            if not line:events.put({'eof':True});return
            try:events.put(json.loads(line))
            except Exception:events.put({'invalid':line.decode(errors='replace')[:200]})
    def errreader():
        while chunk:=process.stderr.read(4096):
            stderr.extend(chunk)
            if len(stderr)>65536:del stderr[:-65536]
    def monitor():
        target=Path('/sys/fs/cgroup/system.slice')/unit/'memory.current'
        while not stopped.wait(.02):
            try:memory.append(int(target.read_text()))
            except FileNotFoundError:pass
    threads=[threading.Thread(target=f,daemon=True) for f in (stdout,errreader,monitor)]
    for t in threads:t.start()
    def receive(test,timeout=12):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            try:frame=events.get(timeout=max(.01,end-time.monotonic()))
            except queue.Empty:break
            if frame.get('eof'):raise RuntimeError('Engine exited: '+stderr.decode(errors='replace'))
            frames.append(frame)
            if test(frame):return frame
        raise TimeoutError('School protocol timeout: '+stderr.decode(errors='replace'))
    def request(method,params):
        nonlocal counter
        counter+=1
        body={'jsonrpc':'2.0','id':counter,'method':method,'params':params}
        process.stdin.write((json.dumps(body)+'\n').encode());process.stdin.flush()
        frame=receive(lambda f:f.get('id')==counter)
        if 'error'in frame:raise RuntimeError(frame['error'])
        return frame['result']
    try:
        initialized=request('initialize',{'provider':'school-mock','model':'poc-fixed'})
        assert initialized['paidCalls'] is False
        opened=request('session/open',{'sessionId':sid})
        assert opened['resumed'] is resume,opened
        prompt=request('session/prompt',{'sessionId':sid,'runId':'proof-'+uuid.uuid4().hex,'text':'Run the three-seam prototype pipeline.'})
        settled=receive(lambda f:f.get('method')=='session.settled' and f.get('params',{}).get('runId')==prompt['runId'])
        assert 'error'not in settled['params'],settled
        assert settled['params']['durable'] and settled['params']['quiescent']
        read=request('session/read',{'sessionId':sid,'cursor':0})
        assert any(e.get('type')=='tool/result' and 'HARNESS_THREE_SEAMS_OK' in json.dumps(e) for e in read['events']),read
        if not resume:
            active=request('session/prompt',{'sessionId':sid,'runId':'cancel-'+uuid.uuid4().hex,'text':'wait-for-cancel'})
            receive(lambda f:f.get('method')=='session.delta' and f.get('params',{}).get('runId')==active['runId'])
            cancelled=request('session/cancel',{'sessionId':sid,'runId':active['runId']})
            assert cancelled['quiescent'],cancelled
        request('shutdown',{})
        code=process.wait(timeout=8)
        assert code==0,(code,stderr.decode(errors='replace'))
        return {'resumed':resume,'eventCount':len(read['events']),'persistedCursor':settled['params']['persistedCursor'],
                'streamFrames':sum(f.get('method')=='session.delta' for f in frames),
                'sampledCgroupPeakBytes':max(memory,default=0),'memorySampleIntervalMs':20,'stderr':stderr.decode(errors='replace')}
    finally:
        stopped.set()
        if process.poll() is None:
            subprocess.run(['systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            process.kill();process.wait()
if __name__=='__main__':
    sid='poc-'+uuid.uuid4().hex
    results=[]
    try:
        results.append(run_session(sid))
        results.append(run_session(sid,True))
        report={'suite':'school-profile-real-composition','passed':True,'paidCalls':0,'sessions':results}
    except Exception as e:
        report={'suite':'school-profile-real-composition','passed':False,'error':str(e),'sessions':results}
    print(json.dumps(report,indent=2))
    raise SystemExit(0 if report['passed'] else 1)
