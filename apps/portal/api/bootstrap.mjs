import {DatabaseSync} from 'node:sqlite'
import {hash} from '@node-rs/argon2'
import {randomBytes} from 'node:crypto'
import {existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs'
const credentials='/var/lib/vibe-os/portal-private/student-logins.json'
if(existsSync(credentials))throw new Error('Student credentials already exist; bootstrap is one-time')
const db=new DatabaseSync('/var/lib/vibe-os/portal/portal.sqlite')
db.exec('PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL')
if(db.prepare('SELECT count(*) n FROM users').get().n!==0)throw new Error('Users already exist')
const rows=[]
for(let i=1;i<=5;i++){
 const login='student0'+i,password='Vibe-'+randomBytes(9).toString('base64url'),id=randomBytes(16).toString('hex')
 const encoded=await hash(password,{memoryCost:19456,timeCost:2,parallelism:1})
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,login,'Ученик 0'+i,encoded,i,1,Date.now())
 rows.push({login,password,student:i})
}
writeFileSync(credentials,JSON.stringify(rows,null,2)+'\n',{mode:0o400});chmodSync(credentials,0o400)
db.close()
console.log('Five student accounts created; credentials protected on server.')
