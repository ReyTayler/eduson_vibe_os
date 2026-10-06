import {openControl} from './control/index.mjs'
import {digest} from './authorize.mjs'
const db=openControl('/var/lib/vibe-os/poc-control/control.sqlite')
try{
 if(!db.prepare("SELECT id FROM users WHERE id='poc-student'").get())db.exec("INSERT INTO users VALUES('poc-student','student')")
 for(let i=1;i<=4;i++){
  const hash=digest(i)
  if(!db.prepare('SELECT id FROM projects WHERE id=?').get('demo'+i)){
   db.prepare('INSERT INTO projects(id,owner_id) VALUES(?,?)').run('demo'+i,'poc-student')
   db.prepare('INSERT INTO releases(id,project_id,content_sha,sealed) VALUES(?,?,?,1)').run('demo-r'+i,'demo'+i,hash)
   db.prepare('INSERT INTO publish_grants(id,project_id,release_id,valid_until) VALUES(?,?,?,NULL)').run('demo-g'+i,'demo'+i,'demo-r'+i)
  }
 }
}finally{db.close()}
