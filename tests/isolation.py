#!/usr/bin/env python3
import json, time, sys
from poc_client import operation
cases=[]
def test(name,fn):
    if len(sys.argv)>1 and name not in sys.argv[1:]: return
    try:
        detail=fn()
        cases.append({'name':name,'passed':True,'detail':detail})
    except Exception as e:
        cases.append({'name':name,'passed':False,'error':str(e)})
def command(code,timeout=2000,program='python'):
    r=operation({'op':'run','program':program,'args':['-c',code] if program!='node' else ['-e',code],'timeoutMs':timeout})
    assert r['cgroupEmpty'],r
    return r
def passed(code,needle=None,program='python'):
    r=command(code,program=program)
    assert r['exitCode']==0,r
    if needle is not None: assert needle in r['stdout']['text'],r
    return r
def denied(body):
    try: operation(body)
    except RuntimeError as e: return {'rejected':str(e)}
    raise AssertionError('operation was admitted')
test('python runs as uid 1000',lambda:passed('import os; assert os.getuid()==1000; print(os.getcwd())','/workspace'))
test('node runs with address-space limit unlimited',lambda:passed('console.log(process.version)','v24.21.0','node'))
test('tool filesystem excludes host and other projects',lambda:passed('from pathlib import Path; assert not Path("/root/.ssh").exists(); assert not Path("/srv/vibe-os/data/poc-project-2").exists(); assert not Path("/var/lib/vibe-os/poc-engine").exists(); print("confined")','confined'))
test('INET and INET6 sockets denied',lambda:passed('import socket,errno\nfor f in (socket.AF_INET,socket.AF_INET6):\n try: socket.socket(f,socket.SOCK_STREAM)\n except OSError as e: assert e.errno==errno.EPERM\n else: raise AssertionError("INET allowed")\nprint("egress denied")','egress denied'))
test('tool environment contains no engine configuration',lambda:passed('import os; assert not any("KEY" in k or "TOKEN" in k or k.startswith("DSH_") for k in os.environ); print("scrubbed")','scrubbed'))
test('broker absolute escape denied',lambda:denied({'op':'read','path':'/etc/shadow'}))
test('broker parent traversal denied',lambda:denied({'op':'write','path':'../outside.txt','text':'bad'}))
def symlink():
    return denied({'op':'read','path':'escape-link'})
test('broker symlink escape denied by openat2',symlink)
def write_guard():
    r=operation({'op':'write','path':'guard.txt','text':'v1'})
    version=r['version']
    operation({'op':'write','path':'guard.txt','text':'v2','guard':{'kind':'replaceIfVersion','version':version}})
    return denied({'op':'write','path':'guard.txt','text':'stale','guard':{'kind':'replaceIfVersion','version':version}})
test('stale observed version rejected',write_guard)
def edit_expand():
    operation({'op':'write','path':'guard.txt','text':'x'*65536})
    return denied({'op':'edit','path':'guard.txt','old':'x','new':'y'*32768,'replaceAll':True})
test('edit expansion rejected before allocation',edit_expand)
def output():
    r=passed('import sys; sys.stdout.write("A"*1048576); sys.stderr.write("B"*1048576)')
    assert r['stdout']['truncated'] and r['stderr']['truncated'],r
    assert len(r['stdout']['text'].encode())<=65536 and len(r['stderr']['text'].encode())<=65536,r
    return {k:r[k] for k in ['exitCode','cgroupEmpty']}|{'stdoutTotalBytes':r['stdout']['totalBytes'],'capturedBytes':len(r['stdout']['text'])}
test('stdout and stderr capture bounded',output)
def timeout():
    r=command('import time; print("start",flush=True); time.sleep(10)',200)
    assert r['timedOut'] and r['cgroupEmpty'],r
    return r
test('deadline stops entire cgroup',timeout)
def orphan():
    passed('import os,time\nr,w=os.pipe()\npid=os.fork()\nif pid==0:\n os.close(r)\n if os.fork()!=0: os._exit(0)\n os.setsid();print("daemon-detached",flush=True);os.write(w,b"X");time.sleep(0.6);open("orphan-marker","w").write("escaped")\nelse:\n os.close(w);os.read(r,1);os._exit(0)','daemon-detached')
    time.sleep(0.8)
    r=operation({'op':'stat','path':'orphan-marker'})
    assert r is None,r
    return {'markerAbsent':True}
test('double-fork background cannot survive command',orphan)
def memory():
    r=command('x=bytearray(400*1024*1024); print(len(x))',3000)
    assert r['exitCode']!=0 and not r['timedOut'],r
    return r
test('256 MiB cgroup kills memory exhaustion',memory)
def pids():
    code='import os,time,errno\nn=0\nfor i in range(120):\n try: pid=os.fork()\n except OSError as e:\n  assert e.errno==errno.EAGAIN;print("pid-limit",n,flush=True);break\n if pid==0:\n  time.sleep(10);os._exit(0)\n n+=1\nelse: raise AssertionError("PID limit missing")\n'
    return passed(code,'pid-limit')
test('64 task cgroup bounds fork flood',pids)
def blocks():
    code='import os,errno\nf=open("quota-bytes","wb")\ntry:\n for i in range(16384): f.write(bytes(4096));f.flush()\nexcept OSError as e:\n assert e.errno in (errno.EDQUOT,errno.ENOSPC),e;print("byte-quota",flush=True)\nelse: raise AssertionError("byte quota missing")\nfinally:\n try: f.close()\n except OSError: pass\n os.unlink("quota-bytes")'
    return passed(code,'byte-quota')
test('XFS project hard byte quota enforced',blocks)
def inodes():
    code='import os,errno\nnames=[]\ntry:\n for i in range(600):\n  p="inode-"+str(i);open(p,"w").close();names.append(p)\nexcept OSError as e:\n assert e.errno in (errno.EDQUOT,errno.ENOSPC),e;print("inode-quota",len(names),flush=True)\nelse: raise AssertionError("inode quota missing")\nfinally:\n for p in names: os.unlink(p)'
    return passed(code,'inode-quota')
test('XFS project hard inode quota enforced',inodes)
print(json.dumps({'suite':'runner-isolation-poc','cases':cases,'passed':sum(c['passed'] for c in cases),'total':len(cases)},indent=2))
raise SystemExit(0 if all(c['passed'] for c in cases) else 1)
