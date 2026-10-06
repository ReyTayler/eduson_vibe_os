/** Local read-only fixture console; a fixed-route Nginx proxy provides the public test view. */
import http from 'node:http'
import {readFileSync} from 'node:fs'
function status(){return JSON.parse(readFileSync('/var/lib/vibe-os/poc-control/status.json','utf8')).slots}
http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return}
 res.setHeader('Cache-Control','no-store')
 if(req.url==='/status.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({phase:'technical-poc',paidApiExposed:false,slots:status()}));return}
 const match=/^\/projects\/([1-4])(?:\/.*)?$/.exec(req.url)
 if(match){
  const number=match[1]
  const upstream=http.request({socketPath:'/run/vibe-os-poc-app'+number+'/http.sock',method:'GET',path:'/'},response=>{
   res.writeHead(response.statusCode??502,{'Content-Type':'text/html;charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"})
   let bytes=0
   response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){response.destroy();res.destroy();return}res.write(chunk)})
   response.on('end',()=>res.end())
  })
  upstream.setTimeout(3000,()=>upstream.destroy(new Error('Project timeout')))
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'text/plain;charset=utf-8'});res.end('Проект выключен или недоступен')})
  upstream.end();return
 }
 if(req.url!=='/'){res.writeHead(404);res.end();return}
 const rows=status()
 res.setHeader('Content-Type','text/html;charset=utf-8')
 res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
 res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vibe OS — прототип</title><style>body{font:17px system-ui;background:#f3f4f8;color:#192238;margin:8vh auto;max-width:880px;padding:24px}header{margin-bottom:32px}h1{font-size:40px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}article{background:white;padding:28px;border-radius:20px}a{color:#6755ed;text-decoration:none;font-weight:650}small{color:#65708a}footer{margin-top:32px}</style><header><small>Тестовый стенд</small><h1>Vibe OS</h1><p>Три работающих демопроекта на одном сервере.</p></header><section>'+rows.map(r=>'<article><small>Слот '+r.slot_no+'</small><h2><a href="/projects/'+(r.project_id?.replace('demo','')??r.slot_no)+'/">Проект '+r.slot_no+'</a></h2><p>'+({'running':'Работает','stopped':'Остановлен','stopping':'Останавливается','starting':'Запускается'}[r.observed]??'Проверяется')+'</p><small>Данные сохраняются при остановке проекта.</small></article>').join('')+'</section><footer><p>Откройте демопроекты, чтобы проверить их доступность. Редактор проектов и чат с ИИ ещё готовятся.</p></footer></html>')
}).listen(8810,'127.0.0.1')
