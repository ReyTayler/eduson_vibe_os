#!/usr/bin/env python3
import subprocess,json,re,time,urllib.request
from pathlib import Path
BASE='http://127.0.0.1:8810'
CLI=['node','/opt/vibe-os/poc-hosting/cli.mjs']
cases=[]
def state():
    return json.loads(subprocess.check_output(CLI+['status'],text=True))
def command(*args,expected=0):
    r=subprocess.run(CLI+list(args),capture_output=True,text=True)
    if expected==0:assert r.returncode==0,r.stderr
    else:assert r.returncode!=0,'Forbidden transition was admitted'
    return r
def page(n):
    with urllib.request.urlopen(BASE+'/projects/'+str(n)+'/',timeout=4) as res:
        return res.read().decode()
def count(n):
    return int(re.search(r'<b>(\d+)</b>',page(n)).group(1))
def check(name,fn):
    try:cases.append({'name':name,'passed':True,'detail':fn()})
    except Exception as e:cases.append({'name':name,'passed':False,'error':str(e)})
def three():
    rows=state()
    assert sum(r['resource_held'] for r in rows)==3
    for n in range(1,4):assert 'SQLite' in page(n)
    return {'held':3,'activeProjects':['demo1','demo2','demo3']}
check('three real isolated services respond',three)
def fourth():
    r=command('enable','4','1',expected=1)
    assert 'OCCUPIED'in r.stderr
    assert sum(r['resource_held'] for r in state())==3
    assert subprocess.run(['systemctl','is-active','vibe-os-poc-app4'],capture_output=True).returncode!=0
    return {'fourthStartRejected':True}
check('fourth real service cannot start into an occupied slot',fourth)
saved=count(1)
def replace():
    command('disable','1')
    assert sum(r['resource_held'] for r in state())==2
    assert Path('/srv/vibe-os/data/poc-live-1/app.sqlite').exists()
    command('enable','4','1')
    assert 'Проект 4'in page(4)
    assert sum(r['resource_held'] for r in state())==3
    command('disable','4');command('enable','1','1')
    now=count(1)
    assert now>saved,(now,saved)
    return {'oldCount':saved,'restoredCount':now,'dataPreserved':True}
check('manual switch retains SQLite and never occupies four slots',replace)
def restriction():
    command('restrict','1')
    r=command('enable','1','1',expected=1)
    assert 'DEPLOYMENT_RESTRICTED'in r.stderr
    return {'restrictionPersists':True,'project1DisabledForRebootCheck':True}
check('durable teacher restriction blocks a real re-enable',restriction)
before={}
for n in [2,3]:before[str(n)]=count(n)
Path('/opt/vibe-os/platform/evidence/reboot-before.json').write_text(json.dumps({'counter':before,'restriction':True,'approvedActive':[2,3],'slots':state()},indent=2)+'\n')
result={'suite':'real-hosting-lifecycle','cases':cases,'passed':sum(c['passed'] for c in cases),'total':len(cases)}
print(json.dumps(result,indent=2))
raise SystemExit(0 if result['passed']==result['total'] else 1)
