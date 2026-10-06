#!/usr/bin/env python3
from pathlib import Path
import json, os, subprocess
image=Path('/var/lib/vibe-os/poc-data.xfs')
mount=Path('/srv/vibe-os/data')
image.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
mount.mkdir(mode=0o755, parents=True, exist_ok=True)
if image.exists():
    if image.is_symlink() or not image.is_file(): raise RuntimeError('Invalid existing image')
    got=subprocess.check_output(['blkid','-p','-s','TYPE','-o','value',str(image)],text=True).strip()
    if got!='xfs': raise RuntimeError('Existing file is not our XFS image; refusing to format')
else:
    fd=os.open(image,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    os.close(fd)
    subprocess.run(['fallocate','-l',str(16*1024**3),str(image)],check=True)
    subprocess.run(['mkfs.xfs','-L','vibe-poc',str(image)],check=True)
unit=subprocess.check_output(['systemd-escape','--path','--suffix=mount',str(mount)],text=True).strip()
content='''[Unit]
Description=Vibe OS prototype XFS file on single system disk
RequiresMountsFor=/var/lib/vibe-os

[Mount]
What=/var/lib/vibe-os/poc-data.xfs
Where=/srv/vibe-os/data
Type=xfs
Options=loop,nodev,nosuid,noexec,noatime,prjquota

[Install]
WantedBy=local-fs.target
'''
Path('/etc/systemd/system',unit).write_text(content)
Path('/opt/vibe-os/platform/infra/systemd',unit).write_text(content)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now',unit],check=True)
fs=json.loads(subprocess.check_output(['findmnt','--json',str(mount)],text=True))
Path('/opt/vibe-os/platform/evidence/storage.json').write_text(json.dumps({'prototype_only':True,'backing':'regular file on /dev/sda1 ext4','image_bytes':image.stat().st_size,'mount':fs},indent=2)+'\n')
print(json.dumps(fs,indent=2))
