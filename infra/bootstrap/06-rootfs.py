#!/usr/bin/env python3
from pathlib import Path
import subprocess, shutil, re, os, json
dst=Path('/opt/vibe-os/rootfs')
dst.mkdir(mode=0o755,exist_ok=True)
for directory in ['dev','proc','tmp','workspace','home/pupil','etc','usr/bin','bin','usr/lib','lib','lib64','data']:
    (dst/directory).mkdir(parents=True,exist_ok=True)
bins=['/bin/bash','/bin/sh','/usr/bin/python3.10','/usr/local/bin/node','/usr/bin/rg']
for name in ['cat','cp','mv','mkdir','rm','touch','sleep','env','id','stat','find','head','tail','wc','sort','cut','sed','awk','true','false','dd','timeout','yes','ln','ls','du','xargs','date']:
    p=shutil.which(name)
    if p: bins.append(p)
copied=set()
def copy_binary(path,target=None):
    real=Path(path).resolve()
    out=dst/(target or str(path).lstrip('/'))
    out.parent.mkdir(parents=True,exist_ok=True)
    if out not in copied:
        shutil.copy2(real,out)
        copied.add(out)
    result=subprocess.run(['ldd',str(real)],capture_output=True,text=True)
    for dep in re.findall(r'(?:=>\s*)?(/[^\s]+)',result.stdout):
        lib=Path(dep)
        if lib.is_file():
            end=dst/dep.lstrip('/')
            end.parent.mkdir(parents=True,exist_ok=True)
            if end not in copied:
                shutil.copy2(lib.resolve(),end)
                copied.add(end)
for p in bins:
    target='usr/bin/node' if p=='/usr/local/bin/node' else str(p).lstrip('/')
    copy_binary(p,target)
shutil.copytree('/usr/lib/python3.10',dst/'usr/lib/python3.10',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','test','tests','ensurepip','idlelib','tkinter'))
for extension in (dst/'usr/lib/python3.10/lib-dynload').glob('*.so'):
    original=Path('/usr/lib/python3.10/lib-dynload')/extension.name
    copy_binary(original)
(dst/'etc/passwd').write_text('pupil:x:1000:1000:Sandbox user:/home/pupil:/bin/bash\n')
(dst/'etc/group').write_text('pupil:x:1000:\n')
(dst/'etc/hosts').write_text('127.0.0.1 localhost\n::1 localhost\n')
(dst/'etc/nsswitch.conf').write_text('passwd: files\ngroup: files\nhosts: files\n')
(dst/'etc/os-release').write_text('NAME=VibeOS-Jail\nVERSION_ID=poc1\n')
for path in dst.rglob('*'):
    if path.is_file():
        path.chmod(0o555 if os.access(path,os.X_OK) else 0o444)
    elif path.is_dir():
        path.chmod(0o755)
for name in ['null','urandom','random']:
    p=dst/'dev'/name
    if not p.exists(): p.touch(mode=0o444)
sqlite=Path('/opt/vibe-os/build/sqlite-3.51.3/libsqlite3.so.0')
if sqlite.exists():
    shutil.copy2(sqlite,dst/'lib/x86_64-linux-gnu/libsqlite3.so.0')
    (dst/'lib/x86_64-linux-gnu/libsqlite3.so.0').chmod(0o444)
print('Prepared rootfs:',dst)
