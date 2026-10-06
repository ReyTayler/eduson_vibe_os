#!/usr/bin/env python3
import http.client, socket, json
from pathlib import Path
class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect('/run/vibe-os-poc/runner.sock')
def operation(body):
    conn=UnixHTTP('localhost')
    token=Path('/var/lib/vibe-os/poc-engine/capability').read_text().strip()
    conn.request('POST','/v1/operation',json.dumps(body),{'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    response=conn.getresponse()
    raw=response.read(3*1024**2)
    conn.close()
    result=json.loads(raw)
    if response.status!=200: raise RuntimeError(result)
    return result['result']
if __name__=='__main__':
    print(json.dumps(operation({'op':'run','program':'python','args':['-c','import os; print(os.getuid(),os.getcwd())']}),indent=2))
