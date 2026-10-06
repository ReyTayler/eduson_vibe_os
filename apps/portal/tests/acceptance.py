
#!/usr/bin/env python3
"""Five real student sessions and negative tenant, CSRF, filesystem and hosting acceptance; no paid calls."""
import json,urllib.request,urllib.error,http.cookiejar,uuid,time
from pathlib import Path
ORIGIN='https://80.249.145.94'
accounts=json.loads(Path('/var/lib/vibe-os/portal-private/student-logins.json').read_text())
checks=[]
class Student:
 def __init__(self,account):
  self.jar=http.cookiejar.CookieJar();self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar));self.csrf=''
  self.call('POST','/auth/login',{k:account[k]for k in ['login','password']})
  self.me=self.call('GET','/me');self.csrf=self.me['csrf']
 def call(self,method,path,body=None,expected=200,extra=None):
  headers={'Origin':ORIGIN,'X-CSRF-Token':self.csrf}
  if body is not None:headers['Content-Type']='application/json'
  if extra:headers.update(extra)
  req=urllib.request.Request(ORIGIN+'/api'+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
  try:
   with self.opener.open(req,timeout=30)as r:status=r.status;raw=r.read()
  except urllib.error.HTTPError as e:status=e.code;raw=e.read()
  if status!=expected:raise AssertionError(method+' '+path+' expected '+str(expected)+' got '+str(status)+' '+raw.decode(errors='replace')[:500])
  if expected!=200:checks.append({'check':method+' '+path,'status':status})
  return json.loads(raw) if raw else {}
users=[Student(a)for a in accounts]
u,v=users[:2];first=u.call('GET','/projects');seed=json.loads(Path('/opt/vibe-os/platform/evidence/student-seed.json').read_text());web=seed['webProject'];py=seed['pythonProject']
for actor in users[1:]:assert actor.call('GET','/projects')==[];assert actor.call('GET','/folders')==[]
checks.append({'check':'five private accounts; only student one has starter projects','passed':True})
chats=u.call('GET','/projects/'+web+'/chats');chat=chats[0]['id']
for method,p,b in [
 ('GET','/projects/'+web+'/files',None),('GET','/projects/'+web+'/file?path=index.html',None),
 ('GET','/projects/'+web+'/chats',None),('POST','/projects/'+web+'/chats',{}),
 ('POST','/projects/'+web+'/run',{'command':'node -e "console.log(1)"'}),
 ('POST','/projects/'+web+'/hosting',{'enabled':False}),('DELETE','/projects/'+web,{}),
 ('GET','/chats/'+chat,None),('POST','/chats/'+chat+'/messages',{'text':'hello'})
]:v.call(method,p,b,404)
u.call('POST','/folders',{'name':'must-not-create'},403,{'X-CSRF-Token':'bad'})
u.call('POST','/folders',{'name':'must-not-create'},403,{'Origin':'https://attacker.invalid'})
u.call('GET','/projects/'+web+'/file?path=..%2F..%2Fetc%2Fpasswd',None,400)
u.call('POST','/projects',{'name':'must-not-create','kind':'web','user_id':v.me['id']},400)
other=v.call('POST','/projects',{'name':'Приёмка изоляции','kind':'node'})['id']
fixtures=[]
try:
 u.call('GET','/projects/'+other+'/files',None,404)
 tree=v.call('GET','/projects/'+other+'/files')
 v.call('POST','/projects/'+other+'/directories',{'path':'src','revision':tree['revision']})
 tree=v.call('GET','/projects/'+other+'/files')
 created=v.call('PUT','/projects/'+other+'/file',{'path':'src/hello.py','text':'print("ISOLATED_PROJECT_OK")\n','revision':tree['revision']})
 read=v.call('GET','/projects/'+other+'/file?path=src%2Fhello.py');assert read['text']=='print("ISOLATED_PROJECT_OK")\n'
 v.call('PUT','/projects/'+other+'/file',{'path':'src/hello.py','text':'stale','version':read['version'],'revision':read['revision']-1},409)
 updated=v.call('PUT','/projects/'+other+'/file',{'path':'src/hello.py','text':'print("ISOLATED_PROJECT_OK_2")\n','version':read['version'],'revision':read['revision']})
 result=v.call('POST','/projects/'+other+'/run',{'path':'src/hello.py'});assert result['exitCode']==0 and 'ISOLATED_PROJECT_OK_2' in result['stdout']['text'] and result['cgroupEmpty']
 checks.append({'check':'isolated Python real execution and cgroup cleanup','passed':True})
 node=v.call('POST','/projects/'+other+'/run',{'path':'main.js'});assert node['exitCode']==0 and 'Node-проект работает' in node['stdout']['text']
 checks.append({'check':'isolated Node real execution','passed':True})
 denial=v.call('POST','/projects/'+other+'/run',{'command':'python3.10 -c "import os,socket; print(os.getuid()); s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)"'})
 assert '1000' in denial['stdout']['text'] and denial['exitCode']!=0 and denial['cgroupEmpty']
 checks.append({'check':'UID mapping and network socket denied','passed':True})
 escape=v.call('POST','/projects/'+other+'/run',{'command':'python3.10 -c "print(open(\'/var/lib/vibe-os/portal-private/student-logins.json\').read())"'})
 assert escape['exitCode']!=0 and not any(a['password'] in escape['stdout']['text']+escape['stderr']['text'] for a in accounts)
 checks.append({'check':'host credentials inaccessible from student tool jail','passed':True})
 read=v.call('GET','/projects/'+other+'/file?path=src%2Fhello.py')
 v.call('PATCH','/projects/'+other+'/file',{'path':'src/hello.py','newPath':'src/world.py','version':read['version'],'revision':read['revision']})
 tree=v.call('GET','/projects/'+other+'/files');entry=next(f for f in tree['files']if f['path']=='src/world.py')
 v.call('DELETE','/projects/'+other+'/file',{'path':entry['path'],'version':entry['version'],'revision':tree['revision']})
 tree=v.call('GET','/projects/'+other+'/files');entry=next(f for f in tree['files']if f['path']=='src')
 v.call('PATCH','/projects/'+other+'/file',{'path':'src','newPath':'source','version':entry['version'],'revision':tree['revision']})
 tree=v.call('GET','/projects/'+other+'/files');entry=next(f for f in tree['files']if f['path']=='source')
 v.call('DELETE','/projects/'+other+'/file',{'path':'source','version':entry['version'],'revision':tree['revision']})
 checks.append({'check':'create, save, CAS reject, rename and delete nested file and directory','passed':True})
 c=v.call('POST','/projects/'+other+'/chats',{'name':'Мои идеи'})['id']
 v.call('PATCH','/chats/'+c,{'name':'Другие идеи'});assert v.call('GET','/chats/'+c)['name']=='Другие идеи'
 checks.append({'check':'create and rename independent chat','passed':True})
 u.call('GET','/chats/'+c,None,404)
 folder=v.call('POST','/folders',{'name':'Приёмка папки'})['id'];v.call('PATCH','/projects/'+other,{'folderId':folder})
 u.call('PATCH','/projects/'+web,{'folderId':folder},404)
 v.call('PATCH','/folders/'+folder,{'name':'Папка после переименования'});v.call('DELETE','/folders/'+folder,{})
 assert next(p for p in v.call('GET','/projects')if p['id']==other)['folder_id'] is None
 checks.append({'check':'folder ownership, rename and removal preserve projects','passed':True})
 # Three real static hosting slots, update keeps a stable public URL, fourth fails.
 for i in range(3):fixtures.append(u.call('POST','/projects',{'name':'Приёмка хостинга '+str(i+1),'kind':'web'})['id'])
 for f in fixtures[:2]:u.call('POST','/projects/'+f+'/hosting',{'enabled':True})
 u.call('POST','/projects/'+fixtures[2]+'/hosting',{'enabled':True},409)
 p=next(p for p in u.call('GET','/projects')if p['id']==fixtures[0]);url=p['url']
 with urllib.request.urlopen(url,timeout=15)as r:
  assert r.status==200 and 'sandbox allow-scripts' in r.headers['Content-Security-Policy']
 u.call('POST','/projects/'+fixtures[0]+'/hosting',{'enabled':False})
 try:urllib.request.urlopen(url,timeout=10);raise AssertionError('Off project is still public')
 except urllib.error.HTTPError as e:assert e.code==404
 data=u.call('GET','/projects/'+fixtures[0]+'/file?path=index.html')
 assert 'Большие идеи' in data['text']
 u.call('POST','/projects/'+fixtures[2]+'/hosting',{'enabled':True})
 u.call('POST','/projects/'+fixtures[2]+'/hosting',{'enabled':False})
 on=u.call('POST','/projects/'+fixtures[0]+'/hosting',{'enabled':True});assert on['url']==url
 update=u.call('POST','/projects/'+fixtures[0]+'/hosting',{'enabled':True});assert update['url']==url
 checks.append({'check':'maximum three, fourth denied, off/on preserves files, publication URL stable','passed':True})
 for path in ['/api/me','/api/projects','/','/health']:
  try:urllib.request.urlopen(ORIGIN+':8443'+path,timeout=10);raise AssertionError('Portal exposed on preview origin')
  except urllib.error.HTTPError as e:assert e.code==404
 checks.append({'check':'preview origin excludes authentication and API','passed':True})
finally:
 for f in fixtures:u.call('DELETE','/projects/'+f,{})
 v.call('DELETE','/projects/'+other,{})
 assert v.call('GET','/projects')==[]
 for actor in users:actor.call('POST','/auth/logout',{})
report={'suite':'five-student-portal-acceptance','passed':True,'paidCalls':0,'checks':checks,'count':len(checks),'othersRestoredEmpty':True}
Path('/opt/vibe-os/platform/evidence/student-api-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':True,'checks':len(checks),'paidCalls':0,'othersRestoredEmpty':True},ensure_ascii=False))
