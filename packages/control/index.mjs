/** Prototype SQL invariants. All functions execute through one trusted writer. */
import {DatabaseSync} from 'node:sqlite'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
function sqlTokens(sql){
 const withoutLiterals=sql.replace(/'(?:''|[^'])*'|"(?:\"\"|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,' ')
 return (withoutLiterals.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+/g)??[]).map(x=>x.toUpperCase())
}
function checkSQL(sql){
 const t=sqlTokens(sql)
 for(let i=0;i<t.length;i++){
  if(t[i]==='REPLACE'&&t[i+1]==='INTO'
    ||(t[i]==='INSERT'||t[i]==='UPDATE')&&t[i+1]==='OR'&&t[i+2]==='REPLACE'
    ||t[i]==='ON'&&t[i+1]==='CONFLICT'&&t[i+2]==='REPLACE')throw new Error('REPLACE_FORBIDDEN')
  if(t[i]==='PRAGMA'&&['FOREIGN_KEYS','RECURSIVE_TRIGGERS'].includes(t[i+1])&&t[i+2]!==undefined&&!['ON','1'].includes(t[i+2]))throw new Error('WRITER_PRAGMA_IMMUTABLE')
 }
}
class ControlDatabase {
 #db
 constructor(path){
  this.#db=new DatabaseSync(path)
  const version=this.#db.prepare('select sqlite_version() v').get().v.split('.').map(Number)
  if(version[0]<3||version[0]===3&&(version[1]<51||version[1]===51&&version[2]<3))throw new Error('SQLite WAL fix required')
  this.#db.exec('PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON;PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;')
  if(path!==':memory:')this.#db.exec('PRAGMA journal_mode=WAL;')
  if(this.#db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1||this.#db.prepare('PRAGMA recursive_triggers').get().recursive_triggers!==1)throw new Error('Writer pragmas are missing')
  const schema=this.#db.prepare('PRAGMA user_version').get().user_version
  if(schema===0){
   this.#db.exec('BEGIN IMMEDIATE')
   try{
    this.#db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'))
    this.#db.exec('PRAGMA user_version=1;COMMIT')
   }catch(error){this.#db.exec('ROLLBACK');throw error}
  }else if(schema!==1)throw new Error('Unsupported schema generation')
 }
 exec(sql){checkSQL(sql);return this.#db.exec(sql)}
 prepare(sql){checkSQL(sql);return this.#db.prepare(sql)}
 close(){this.#db.close()}
}
export function openControl(path=':memory:'){return new ControlDatabase(path)}
export function transaction(db,fn){
 db.exec('BEGIN IMMEDIATE')
 try{const result=fn();db.exec('COMMIT');return result}
 catch(error){db.exec('ROLLBACK');throw error}
}
export function authorizeExecution(db,user,slot){
 const row=db.prepare('SELECT * FROM hosting_slots WHERE user_id=? AND slot_no=?').get(user,slot)
 if(!row||row.desired!=='on'||!row.resource_held)throw new Error('No occupied enabled slot')
 if(db.prepare('SELECT 1 FROM deployment_restrictions WHERE project_id=? AND active=1').get(row.project_id))throw new Error('DEPLOYMENT_RESTRICTED')
 const grant=db.prepare('SELECT 1 FROM publish_grants WHERE id=? AND project_id=? AND release_id=? AND revoked=0 AND (valid_until IS NULL OR valid_until>unixepoch())').get(row.grant_id,row.project_id,row.release_id)
 if(!grant)throw new Error('PUBLISH_GRANT_INVALID')
 return row
}
export function start(db,user,slot,project,release,grant,expectedGeneration){
 return transaction(db,()=>{
  const prior=db.prepare('SELECT * FROM hosting_slots WHERE user_id=? AND slot_no=?').get(user,slot)
  if(!prior||prior.generation!==expectedGeneration||prior.resource_held)throw new Error('SLOT_CAS_OR_OCCUPIED')
  const result=db.prepare("UPDATE hosting_slots SET project_id=?,release_id=?,grant_id=?,generation=generation+1,desired='on',observed='starting',resource_held=1 WHERE user_id=? AND slot_no=? AND generation=? AND resource_held=0").run(project,release,grant,user,slot,expectedGeneration)
  if(result.changes!==1)throw new Error('SLOT_CAS')
  return authorizeExecution(db,user,slot)
 })
}
export function restart(db,user,slot,expectedGeneration){
 return transaction(db,()=>{
  const prior=authorizeExecution(db,user,slot)
  if(prior.generation!==expectedGeneration)throw new Error('GENERATION_FENCE')
  db.prepare("UPDATE hosting_slots SET generation=generation+1,observed='starting' WHERE user_id=? AND slot_no=?").run(user,slot)
  return authorizeExecution(db,user,slot)
 })
}
export function requestStop(db,user,slot,expectedGeneration){
 const row=db.prepare('SELECT * FROM hosting_slots WHERE user_id=? AND slot_no=?').get(user,slot)
 if(!row||row.generation!==expectedGeneration||!row.resource_held)throw new Error('GENERATION_FENCE')
 db.prepare("UPDATE hosting_slots SET desired='off',observed='stopping' WHERE user_id=? AND slot_no=? AND generation=?").run(user,slot,expectedGeneration)
}
export function releaseAfterStop(db,user,slot,expectedGeneration,receipt){
 // Only the trusted Runner adapter may provide receipts, never browser JSON.
 if(receipt.projectId===undefined||receipt.generation!==expectedGeneration||receipt.cgroupEmpty!==true||typeof receipt.rangeId!=='string')throw new Error('STOP_RECEIPT_INVALID')
 return transaction(db,()=>{
  const row=db.prepare('SELECT * FROM hosting_slots WHERE user_id=? AND slot_no=?').get(user,slot)
  if(!row||row.generation!==expectedGeneration||row.project_id!==receipt.projectId||row.desired!=='off')throw new Error('GENERATION_FENCE')
  db.prepare('INSERT INTO stop_receipts(id,user_id,slot_no,project_id,generation,range_id,empty) VALUES(?,?,?,?,?,?,1)').run(randomUUID(),user,slot,row.project_id,expectedGeneration,receipt.rangeId)
  const changed=db.prepare("UPDATE hosting_slots SET project_id=NULL,release_id=NULL,grant_id=NULL,resource_held=0,observed='empty' WHERE user_id=? AND slot_no=? AND generation=?").run(user,slot,expectedGeneration)
  if(changed.changes!==1)throw new Error('SLOT_CAS')
 })
}
function amount(value){if(!Number.isSafeInteger(value)||value<0)throw new Error('INVALID_MONEY')}
export function reserve(db,requestId,budgetIds,worstMu){
 amount(worstMu)
 if(!budgetIds.length||new Set(budgetIds).size!==budgetIds.length)throw new Error('BUDGET_SCOPES_INVALID')
 return transaction(db,()=>{
  db.prepare("INSERT INTO llm_requests(id,state,reserved_mu) VALUES(?,'reserved',?)").run(requestId,worstMu)
  for(const budget of budgetIds){
   const changed=db.prepare('UPDATE budget_windows SET held_mu=held_mu+? WHERE id=? AND spent_mu+held_mu+?<=limit_mu').run(worstMu,budget,worstMu)
   if(changed.changes!==1)throw new Error('BUDGET_EXCEEDED')
   db.prepare('INSERT INTO request_budget_holds(request_id,budget_id,amount_mu) VALUES(?,?,?)').run(requestId,budget,worstMu)
  }
 })
}
export function markSent(db,id){
 if(db.prepare("UPDATE llm_requests SET state='sent' WHERE id=? AND state='reserved'").run(id).changes!==1)throw new Error('REQUEST_CAS')
}
export function markUncertain(db,id){
 if(db.prepare("UPDATE llm_requests SET state='uncertain' WHERE id=? AND state='sent'").run(id).changes!==1)throw new Error('REQUEST_CAS')
}
export function settle(db,id,actualMu){
 amount(actualMu)
 return transaction(db,()=>{
  const request=db.prepare('SELECT * FROM llm_requests WHERE id=?').get(id)
  if(!request||request.state==='settled'||actualMu>request.reserved_mu||request.state==='reserved'&&actualMu!==0)throw new Error('REQUEST_CAS_OR_AMOUNT')
  const holds=db.prepare('SELECT * FROM request_budget_holds WHERE request_id=?').all(id)
  for(const hold of holds){
   const changed=db.prepare('UPDATE budget_windows SET held_mu=held_mu-?,spent_mu=spent_mu+? WHERE id=? AND held_mu>=?').run(hold.amount_mu,actualMu,hold.budget_id,hold.amount_mu)
   if(changed.changes!==1)throw new Error('BUDGET_HOLD_MISSING')
  }
  if(db.prepare("UPDATE llm_requests SET state='settled',actual_mu=? WHERE id=? AND state=?").run(actualMu,id,request.state).changes!==1)throw new Error('REQUEST_CAS')
 })
}

export function saveRevision(db,project,expectedRevision){
 return transaction(db,()=>{
  if(db.prepare("SELECT 1 FROM agent_runs WHERE project_id=? AND state='leased'").get(project))throw new Error('WORKSPACE_LEASE_HELD')
  if(db.prepare('UPDATE projects SET revision=revision+1 WHERE id=? AND revision=?').run(project,expectedRevision).changes!==1)throw new Error('BASE_REVISION_CHANGED')
 })
}
export function leaseRun(db,runId){
 return transaction(db,()=>{
  const run=db.prepare("SELECT * FROM agent_runs WHERE id=? AND state='queued'").get(runId)
  if(!run)throw new Error('RUN_CAS')
  const project=db.prepare('SELECT revision FROM projects WHERE id=?').get(run.project_id)
  if(!project||project.revision!==run.base_revision)throw new Error('BASE_REVISION_CHANGED')
  db.prepare("UPDATE agent_runs SET state='leased' WHERE id=? AND state='queued'").run(runId)
 })
}
