/** Persistent, non-refundable worst-case token debits: all keys share one authorization. */
import {DatabaseSync} from 'node:sqlite'
export const TOKEN_CEILING=1_000_000
export const CALL_DEBIT=65_536
export class Ledger{
 constructor(path){
  this.db=new DatabaseSync(path)
  this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;')
  this.db.exec(`CREATE TABLE IF NOT EXISTS token_budget(id INTEGER PRIMARY KEY CHECK(id=1),limit_tokens INTEGER NOT NULL CHECK(limit_tokens=1000000),debited_tokens INTEGER NOT NULL DEFAULT 0 CHECK(debited_tokens>=0 AND debited_tokens<=limit_tokens),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)));
CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY,credential_id INTEGER NOT NULL CHECK(credential_id BETWEEN 20 AND 27),body_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('sent','settled','failed','uncertain')),debit INTEGER NOT NULL CHECK(debit=65536),input_tokens INTEGER,output_tokens INTEGER,cache_read INTEGER,cache_write INTEGER,total_tokens INTEGER,http_status INTEGER,created_at INTEGER NOT NULL DEFAULT(unixepoch()),ended_at INTEGER);
INSERT INTO token_budget(id,limit_tokens) SELECT 1,1000000 WHERE NOT EXISTS(SELECT 1 FROM token_budget WHERE id=1);`)
  this.db.prepare("UPDATE model_requests SET state='uncertain',ended_at=unixepoch() WHERE state='sent'").run()
 }
 reserve(id,keyId,hash){
  this.db.exec('BEGIN IMMEDIATE')
  try{
   if(this.db.prepare('SELECT 1 FROM model_requests WHERE id=?').get(id))throw new Error('REQUEST_ALREADY_ADMITTED')
   const r=this.db.prepare('UPDATE token_budget SET debited_tokens=debited_tokens+? WHERE id=1 AND enabled=1 AND debited_tokens+?<=limit_tokens').run(CALL_DEBIT,CALL_DEBIT)
   if(r.changes!==1)throw new Error('TOKEN_BUDGET_EXHAUSTED')
   this.db.prepare("INSERT INTO model_requests(id,credential_id,body_hash,state,debit) VALUES(?,?,?,'sent',?)").run(id,keyId,hash,CALL_DEBIT)
   this.db.exec('COMMIT')
  }catch(e){this.db.exec('ROLLBACK');throw e}
 }
 finish(id,state,usage,status){
  if(!['settled','failed','uncertain'].includes(state))throw new Error('INVALID_STATE')
  this.db.exec('BEGIN IMMEDIATE')
  try{
   const old=this.db.prepare('SELECT * FROM model_requests WHERE id=?').get(id)
   if(!old||old.state!=='sent')throw new Error('REQUEST_SETTLEMENT_CAS')
   if(usage){
    for(const n of Object.values(usage))if(!Number.isSafeInteger(n)||n<0)throw new Error('INVALID_USAGE')
    if(usage.total!==usage.input+usage.output+usage.cacheRead+usage.cacheWrite)throw new Error('INVALID_USAGE')
    if(usage.total>CALL_DEBIT)this.db.prepare('UPDATE token_budget SET enabled=0 WHERE id=1').run()
   }
   this.db.prepare('UPDATE model_requests SET state=?,input_tokens=?,output_tokens=?,cache_read=?,cache_write=?,total_tokens=?,http_status=?,ended_at=unixepoch() WHERE id=? AND state=?').run(state,usage?.input??null,usage?.output??null,usage?.cacheRead??null,usage?.cacheWrite??null,usage?.total??null,status??null,id,'sent')
   this.db.exec('COMMIT')
  }catch(e){this.db.exec('ROLLBACK');throw e}
 }
 status(){
  const b=this.db.prepare('SELECT * FROM token_budget WHERE id=1').get()
  const totals=this.db.prepare("SELECT count(*) attempts,coalesce(sum(total_tokens),0) confirmed_tokens,coalesce(sum(CASE WHEN state IN('sent','uncertain','failed') THEN debit ELSE 0 END),0) uncertain_ceiling FROM model_requests").get()
  return {limitTokens:b.limit_tokens,debitedTokens:b.debited_tokens,remainingAuthorizationTokens:b.limit_tokens-b.debited_tokens,enabled:!!b.enabled,maxRemainingCalls:Math.floor((b.limit_tokens-b.debited_tokens)/CALL_DEBIT),...totals}
 }
 close(){this.db.close()}
}
