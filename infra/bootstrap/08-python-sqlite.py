#!/usr/bin/env python3
from pathlib import Path
import urllib.request,tarfile,hashlib,subprocess,os,json,shutil
base=Path('/opt/vibe-os/build/sqlite-3.51.3')
base.mkdir(exist_ok=True)
url='https://www.sqlite.org/2026/sqlite-autoconf-3510300.tar.gz'
archive=base/'source.tar.gz'
with urllib.request.urlopen(url,timeout=90) as r,archive.open('wb') as out:
 while chunk:=r.read(1024*1024):out.write(chunk)
with tarfile.open(archive) as tar:
 for member in tar.getmembers():
  if member.name.startswith('/') or '..'in Path(member.name).parts:raise RuntimeError('Unsafe source member')
 tar.extractall(base)
source=base/'sqlite-autoconf-3510300/sqlite3.c'
expected='32d5424f97e0a7fc5ed2f6335afbb58be4e0298bd7117a34e39d345ff13d859e'
if hashlib.sha3_256(source.read_bytes()).hexdigest()!=expected:raise RuntimeError('Published source SHA3-256 mismatch')
subprocess.run(['chown','-R','vibe-build:vibe-build',str(base)],check=True)
output=base/'libsqlite3.so.0'
args=['runuser','-u','vibe-build','--','gcc','-O2','-fPIC','-shared','-DSQLITE_THREADSAFE=1','-DSQLITE_ENABLE_COLUMN_METADATA=1','-DSQLITE_ENABLE_FTS5=1','-DSQLITE_ENABLE_RTREE=1','-DSQLITE_DEFAULT_DEFENSIVE=1','-Wl,-soname,libsqlite3.so.0','-o',str(output),str(source),'-lpthread','-ldl','-lm']
subprocess.run(args,check=True)
destination=Path('/opt/vibe-os/rootfs/lib/x86_64-linux-gnu/libsqlite3.so.0')
shutil.copy2(output,destination);os.chown(destination,0,0);destination.chmod(0o444)
record={'version':'3.51.3','sourceUrl':url,'sourceSha3_256':expected,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'librarySha256':hashlib.sha256(output.read_bytes()).hexdigest(),'scope':'Prepared jail rootfs only; Ubuntu system library is unchanged'}
Path('/opt/vibe-os/platform/evidence/python-sqlite.json').write_text(json.dumps(record,indent=2)+'\n')
print('PYTHON_SQLITE_LIBRARY_READY')
