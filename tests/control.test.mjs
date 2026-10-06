import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openControl,start,restart,authorizeExecution,requestStop,releaseAfterStop,reserve,markSent,markUncertain,settle,saveRevision,leaseRun} from '../packages/control/index.mjs'
function seeded(){
 const db=openControl()
 db.exec("INSERT INTO users VALUES('student','student'),('other','student'),('teacher','teacher')")
 for(let i=1;i<=5;i++){
  db.prepare('INSERT INTO projects(id,owner_id) VALUES(?,?)').run('p'+i,'student')
  db.prepare('INSERT INTO releases VALUES(?,?,?,1)').run('r'+i,'p'+i,'a'.repeat(64))
  db.prepare('INSERT INTO publish_grants(id,project_id,release_id,valid_until) VALUES(?,?,?,NULL)').run('g'+i,'p'+i,'r'+i)
 }
 return db
}
function occupied(){const db=seeded();start(db,'student',1,'p1','r1','g1',0);return db}
function reject(fn,pattern){assert.throws(fn,pattern)}
test('three permanent project slots; slot four is rejected',()=>{
 const db=seeded()
 for(let i=1;i<=3;i++)start(db,'student',i,'p'+i,'r'+i,'g'+i,0)
 reject(()=>start(db,'student',4,'p4','r4','g4',0),/SLOT_CAS/)
 reject(()=>db.exec("INSERT INTO hosting_slots(user_id,slot_no) VALUES('student',4)"),/CHECK/)
 assert.equal(db.prepare('SELECT count(*) n FROM hosting_slots WHERE user_id=? AND resource_held=1').get('student').n,3)
 db.close()
})
test('foreign owner cannot occupy a project',()=>{
 const db=seeded()
 reject(()=>start(db,'other',1,'p1','r1','g1',0),/FOREIGN KEY/)
 db.close()
})
test('release and grant are tied to exactly one project',()=>{
 const db=seeded()
 reject(()=>start(db,'student',1,'p1','r2','g2',0),/INVALID|FOREIGN KEY/)
 db.close()
})
test('revoked approval allows observations and stopping but blocks restart',()=>{
 const db=occupied()
 db.exec("UPDATE publish_grants SET revoked=1 WHERE id='g1'")
 db.exec("UPDATE hosting_slots SET observed='failed' WHERE user_id='student' AND slot_no=1")
 reject(()=>restart(db,'student',1,1),/PUBLISH_GRANT_INVALID/)
 requestStop(db,'student',1,1)
 assert.equal(db.prepare('SELECT resource_held FROM hosting_slots WHERE user_id=? AND slot_no=1').get('student').resource_held,1)
 db.close()
})
test('teacher restriction survives reconciling and pupil re-enable',()=>{
 const db=occupied()
 db.exec("INSERT INTO deployment_restrictions VALUES('p1',1,'teacher stop',1)")
 reject(()=>authorizeExecution(db,'student',1),/DEPLOYMENT_RESTRICTED/)
 requestStop(db,'student',1,1)
 releaseAfterStop(db,'student',1,1,{projectId:'p1',generation:1,rangeId:'owned-1',cgroupEmpty:true})
 reject(()=>start(db,'student',1,'p1','r1','g1',1),/DEPLOYMENT_RESTRICTED/)
 db.close()
})
test('failed and unknown workloads still occupy capacity',()=>{
 const db=occupied()
 db.exec("UPDATE hosting_slots SET observed='unknown' WHERE user_id='student' AND slot_no=1")
 reject(()=>start(db,'student',1,'p2','r2','g2',1),/OCCUPIED/)
 reject(()=>db.exec("DELETE FROM hosting_slots WHERE user_id='student' AND slot_no=1"),/HELD_SLOT_DELETE/)
 db.close()
})
test('freeing capacity requires a matching stop receipt',()=>{
 const db=occupied()
 requestStop(db,'student',1,1)
 reject(()=>db.exec("UPDATE hosting_slots SET project_id=NULL,release_id=NULL,grant_id=NULL,resource_held=0,observed='empty' WHERE user_id='student' AND slot_no=1"),/STOP_RECEIPT_REQUIRED/)
 reject(()=>releaseAfterStop(db,'student',1,1,{projectId:'p1',generation:1,rangeId:'owned-1',cgroupEmpty:false}),/INVALID/)
 releaseAfterStop(db,'student',1,1,{projectId:'p1',generation:1,rangeId:'owned-1',cgroupEmpty:true})
 const row=start(db,'student',1,'p2','r2','g2',1)
 assert.equal(row.generation,2)
 reject(()=>requestStop(db,'student',1,1),/GENERATION_FENCE/)
 db.close()
})
for(const [name,sql] of [
 ['INSERT OR REPLACE',"INSERT OR REPLACE INTO hosting_slots(user_id,slot_no) VALUES('student',1)"],
 ['REPLACE INTO',"REPLACE INTO hosting_slots(user_id,slot_no) VALUES('student',1)"],
 ['UPDATE OR REPLACE',"UPDATE OR REPLACE hosting_slots SET slot_no=1 WHERE user_id='student' AND slot_no=2"],
 ['comment-obscured REPLACE',"INSERT OR /* gap */ REPLACE INTO hosting_slots(user_id,slot_no) VALUES('student',1)"],
 ['DDL conflict REPLACE',"CREATE TABLE forbidden(x TEXT UNIQUE ON CONFLICT REPLACE)"],
 ['parent project REPLACE',"REPLACE INTO projects(id,owner_id) VALUES('p1','other')"],
 ['approval REPLACE',"REPLACE INTO publish_grants VALUES('g1','p1','r1',NULL,0)"],
]){
 test(name+' is rejected through every writer statement',()=>{
  const db=occupied()
  reject(()=>db.exec(sql),/REPLACE_FORBIDDEN/)
  reject(()=>db.prepare(sql),/REPLACE_FORBIDDEN/)
  assert.equal(db.prepare('SELECT resource_held FROM hosting_slots WHERE user_id=? AND slot_no=1').get('student').resource_held,1)
  db.close()
 })
}
test('quoted strings and the scalar replace function are permitted',()=>{
 const db=seeded()
 assert.equal(db.prepare("SELECT replace('INSERT OR REPLACE','INSERT','SAFE') v").get().v,'SAFE OR REPLACE')
 db.close()
})
test('writer cannot disable FK or recursive triggers',()=>{
 const db=seeded()
 reject(()=>db.exec('PRAGMA foreign_keys=OFF'),/WRITER_PRAGMA_IMMUTABLE/)
 reject(()=>db.prepare('PRAGMA recursive_triggers=0'),/WRITER_PRAGMA_IMMUTABLE/)
 db.close()
})
test('job cannot reference an agent run from another project',()=>{
 const db=seeded()
 db.exec("INSERT INTO agent_runs VALUES('run','p1',0,'queued')")
 reject(()=>db.exec("INSERT INTO jobs VALUES('job','p2','run','agent')"),/FOREIGN KEY/)
 db.exec("INSERT INTO jobs VALUES('valid','p1','run','agent')")
 db.close()
})
test('queued intentions do not lock manual edits; dispatch validates the revision',()=>{
 const db=seeded()
 db.exec("INSERT INTO agent_runs VALUES('run','p1',0,'queued')")
 saveRevision(db,'p1',0)
 reject(()=>leaseRun(db,'run'),/BASE_REVISION_CHANGED/)
 db.close()
})
test('leased workspace excludes both manual edit and concurrent run',()=>{
 const db=seeded()
 db.exec("INSERT INTO agent_runs VALUES('run','p1',0,'queued'),('second','p1',0,'queued')")
 leaseRun(db,'run')
 reject(()=>saveRevision(db,'p1',0),/LEASE_HELD/)
 reject(()=>leaseRun(db,'second'),/UNIQUE/)
 db.close()
})
test('project count is bounded outside disk quotas',()=>{
 const db=seeded()
 for(let i=6;i<=20;i++)db.prepare('INSERT INTO projects(id,owner_id) VALUES(?,?)').run('p'+i,'student')
 reject(()=>db.exec("INSERT INTO projects(id,owner_id) VALUES('p21','student')"),/PROJECT_ENTITY_LIMIT/)
 db.close()
})
function budgets(db){
 for(const [id,limit] of [['day-old',100],['month-old',100],['school-old',100]])
  db.prepare('INSERT INTO budget_windows(id,subject,period_start,limit_mu) VALUES(?,?,?,?)').run(id,id,1000,limit)
}
test('budget pre-reservation is atomic across all scopes',()=>{
 const db=seeded();budgets(db)
 db.exec("UPDATE budget_windows SET limit_mu=5 WHERE id='school-old'")
 reject(()=>reserve(db,'req',['day-old','month-old','school-old'],10),/BUDGET_EXCEEDED/)
 assert.equal(db.prepare('SELECT sum(held_mu) n FROM budget_windows').get().n,0)
 assert.equal(db.prepare('SELECT count(*) n FROM llm_requests').get().n,0)
 db.close()
})
test('unknown provider outcome keeps every hold',()=>{
 const db=seeded();budgets(db)
 reserve(db,'req',['day-old','month-old','school-old'],20)
 markSent(db,'req');markUncertain(db,'req')
 assert.equal(db.prepare('SELECT sum(held_mu) n FROM budget_windows').get().n,60)
 reject(()=>markSent(db,'req'),/REQUEST_CAS/)
 reject(()=>reserve(db,'req',['day-old'],1),/UNIQUE/)
 db.close()
})
test('settlement uses reserved window ids after midnight and rejects double settlement',()=>{
 const db=seeded();budgets(db)
 reserve(db,'req',['day-old','month-old','school-old'],20);markSent(db,'req')
 db.exec("INSERT INTO budget_windows(id,subject,period_start,limit_mu) VALUES('day-new','day',2000,100)")
 settle(db,'req',12)
 assert.equal(db.prepare("SELECT spent_mu FROM budget_windows WHERE id='day-old'").get().spent_mu,12)
 assert.equal(db.prepare("SELECT spent_mu FROM budget_windows WHERE id='day-new'").get().spent_mu,0)
 assert.equal(db.prepare('SELECT sum(held_mu) n FROM budget_windows').get().n,0)
 reject(()=>settle(db,'req',12),/REQUEST_CAS/)
 db.close()
})
test('budget window and hold identities cannot be moved',()=>{
 const db=seeded();budgets(db);reserve(db,'req',['day-old'],20)
 reject(()=>db.exec("UPDATE request_budget_holds SET budget_id='month-old' WHERE request_id='req'"),/HOLD_IMMUTABLE/)
 reject(()=>db.exec("UPDATE budget_windows SET period_start=2000 WHERE id='day-old'"),/SCOPE_IMMUTABLE/)
 db.close()
})
test('WAL reopen retains uncertain holds and mandatory writer settings',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vibe-control-'))
 const file=join(dir,'control.sqlite')
 try{
  let db=openControl(file);budgets(db);reserve(db,'req',['day-old','month-old'],20);markSent(db,'req');markUncertain(db,'req');db.close()
  db=openControl(file)
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal')
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1)
  assert.equal(db.prepare('PRAGMA recursive_triggers').get().recursive_triggers,1)
  assert.equal(db.prepare('SELECT sum(held_mu) n FROM budget_windows').get().n,40)
  assert.equal(db.prepare("SELECT state FROM llm_requests WHERE id='req'").get().state,'uncertain')
  db.close()
 }finally{rmSync(dir,{recursive:true,force:true})}
})
