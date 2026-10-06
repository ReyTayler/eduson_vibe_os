/** Trusted canary: private HTTP-over-Unix service with project-local SQLite. */
import http from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {existsSync,unlinkSync} from 'node:fs'
process.umask(0o117)
const db=new DatabaseSync('/data/app.sqlite',{allowExtension:false})
db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA trusted_schema=OFF;CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY CHECK(id=1),count INTEGER NOT NULL);INSERT INTO visits(id,count) VALUES(1,0) ON CONFLICT(id) DO NOTHING;')
const socket='/ingress/http.sock'
if(existsSync(socket))unlinkSync(socket)
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return}
 const count=db.prepare('UPDATE visits SET count=count+1 WHERE id=1 RETURNING count').get().count
 const label=process.env.APP_LABEL
 res.setHeader('Content-Type','text/html;charset=utf-8')
 res.setHeader('Cache-Control','no-store')
 res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vibe OS — '+label+'</title><style>body{font:18px system-ui;background:#f2f4f7;color:#172238;max-width:700px;margin:12vh auto;padding:24px}main{background:white;border-radius:24px;padding:40px}b{font-size:48px;color:#6551ed}a{color:#6551ed}</style><main><p>Проверка постоянного хостинга Vibe OS</p><h1>'+label+'</h1><p>Открытий: <b>'+count+'</b></p><p>Счётчик хранится в отдельной SQLite этого проекта. Выключение сохраняет данные.</p><a href="/">Все проекты</a></main></html>')
})
server.maxHeadersCount=32
server.requestTimeout=5000
server.headersTimeout=5000
server.listen(socket)
