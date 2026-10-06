#!/usr/bin/env python3
from pathlib import Path
import hashlib, json, os, subprocess, tarfile, urllib.request
ROOT=Path('/opt/vibe-os/toolchain')
ROOT.mkdir(parents=True,exist_ok=True)
record={}
def fetch(url):
    with urllib.request.urlopen(url,timeout=90) as response:
        return response.read()
def archive(url,name,sha):
    p=ROOT/name
    if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()!=sha:
        with urllib.request.urlopen(url,timeout=90) as r, p.with_suffix(p.suffix+'.part').open('wb') as w:
            while chunk:=r.read(1024*1024): w.write(chunk)
        p.with_suffix(p.suffix+'.part').rename(p)
    actual=hashlib.sha256(p.read_bytes()).hexdigest()
    if actual!=sha: raise RuntimeError('Archive SHA-256 mismatch: '+name)
    with tarfile.open(p) as t:
        for member in t.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts:
                raise RuntimeError('Unsafe archive member')
        t.extractall(ROOT)
    return actual
node='24.21.0'
name=f'node-v{node}-linux-x64.tar.xz'
sums=fetch(f'https://nodejs.org/dist/v{node}/SHASUMS256.txt').decode()
sha=next(line.split()[0] for line in sums.splitlines() if line.split()[-1]==name)
record['node']={'version':node,'sha256':archive(f'https://nodejs.org/dist/v{node}/{name}',name,sha)}
go='1.27.1'
releases=json.loads(fetch('https://go.dev/dl/?mode=json&include=all'))
release=next(r for r in releases if r['version']=='go'+go)
file=next(f for f in release['files'] if f['os']=='linux' and f['arch']=='amd64' and f['kind']=='archive')
record['go']={'version':go,'sha256':archive('https://go.dev/dl/'+file['filename'],file['filename'],file['sha256'])}
for name,target in {'node':ROOT/f'node-v{node}-linux-x64/bin/node','npm':ROOT/f'node-v{node}-linux-x64/bin/npm','npx':ROOT/f'node-v{node}-linux-x64/bin/npx','go':ROOT/'go/bin/go'}.items():
    dest=Path('/usr/local/bin')/name
    if dest.is_symlink(): dest.unlink()
    elif dest.exists(): raise RuntimeError('Refusing to replace existing binary '+str(dest))
    dest.symlink_to(target)
prefix=ROOT/'pnpm'
prefix.mkdir(exist_ok=True)
subprocess.run(['chown','vibe-build:vibe-build',str(prefix)],check=True)
subprocess.run(['runuser','-u','vibe-build','--','npm','install','--prefix',str(prefix),'--ignore-scripts','--no-audit','--no-fund','pnpm@11.7.0'],check=True)
dest=Path('/usr/local/bin/pnpm')
if dest.is_symlink(): dest.unlink()
elif dest.exists(): raise RuntimeError('Refusing to replace existing pnpm')
dest.symlink_to(prefix/'node_modules/.bin/pnpm')
record['pnpm']={'version':subprocess.check_output(['pnpm','--version'],text=True).strip()}
Path('/opt/vibe-os/platform/evidence/toolchain.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
