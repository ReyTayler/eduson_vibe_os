
/** Tests four chat settings and native Harness initialization; uses a disposable owned project. */
import http from 'node:http';
import{readFileSync,writeFileSync}from'node:fs';
import{randomBytes}from'node:crypto';
import{execFileSync}from'node:child_process';
import{chromium}from'playwright';
const origin='https://80.249.145.94',account=JSON.parse(readFileSync('/var/lib/vibe-os/portal-private/student-logins.json'))[4];
const cap=readFileSync('/var/lib/vibe-os/portal-private/broker-capability','utf8').trim();
let cookie='',csrf='',project,browser;const checks=[],errors=[];
const budget=()=>JSON.parse(execFileSync('node',['/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs','status'])).overview.lifetime;
const before=budget();
function assert(ok,msg){if(!ok)throw new Error(msg)}
async function api(method,path,body,expected=200){
 const response=await fetch(origin+'/api'+path,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await response.json();
 assert(response.status===expected,method+' '+path+' '+response.status+' '+data.error);return data;
}
function inspect(chat,mode){
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath:'/run/vibe-os-portal/broker.sock',path:'/v1/request',method:'POST',headers:{Authorization:'Bearer '+cap,'Content-Type':'application/json'}},res=>{
   let data='';res.setEncoding('utf8');res.on('data',c=>data+=c);res.on('end',()=>{
    try{assert(res.statusCode===200,'Inspect '+res.statusCode);const block=data.split('\n\n').find(s=>s.startsWith('event: inspected\n'));assert(block,'Engine initialize failed');resolve(JSON.parse(block.split('\ndata: ')[1]))}catch(e){reject(e)}
   });res.on('error',reject);
  });req.on('error',reject);req.end(JSON.stringify({op:'inspect',project,chat,run:randomBytes(16).toString('hex'),reasoningMode:mode}));
 });
}
try{
 await api('POST','/auth/login',{login:account.login,password:account.password});csrf=(await api('GET','/me')).csrf;
 project=(await api('POST','/projects',{name:'Проверка переключателя ИИ',kind:'python'})).id;
 const chat=(await api('GET','/projects/'+project+'/chats'))[0].id;
 for(const mode of ['off','low','high','max']){
  await api('PATCH','/chats/'+chat,{reasoningMode:mode});const value=await api('GET','/chats/'+chat);assert(value.reasoning_mode===mode,'Chat setting not persisted');
  const engine=await inspect(chat,mode);assert(engine.reasoningMode===mode&&engine.maxTokens===393216&&engine.paidCalls===0,'Engine settings mismatch');
  checks.push('persisted '+mode+' setting and native engine initialization with provider max_tokens');
 }
 await api('PATCH','/chats/'+chat,{reasoningMode:'ultra'},400);
 await api('PATCH','/chats/'+chat,{reasoningMode:'off'});
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin,{waitUntil:'networkidle'});await page.getByLabel('Логин',{exact:true}).fill(account.login);await page.getByLabel('Пароль',{exact:true}).fill(account.password);
 await page.getByRole('button',{name:'Войти в пространство'}).click();await page.getByRole('button',{name:'Открыть Проверка переключателя ИИ'}).click();
 const select=page.getByLabel('Режим рассуждений');await select.waitFor();
 assert((await select.locator('option').allTextContents()).join(',')==='Выключены,Low,High,Max','Mode choices mismatch');
 for(const mode of ['low','high','max','off']){
  await select.selectOption(mode);await page.waitForFunction(m=>document.querySelector('#reasoning-mode')?.value===m&&!document.querySelector('#reasoning-mode')?.disabled,mode);
  assert((await api('GET','/chats/'+chat)).reasoning_mode===mode,'Browser mode not saved');
 }
 await select.selectOption('high');await page.waitForFunction(()=>document.querySelector('#reasoning-mode')?.value==='high'&&!document.querySelector('#reasoning-mode')?.disabled);
 await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'Открыть Проверка переключателя ИИ'}).click();await select.waitFor();await page.waitForFunction(()=>document.querySelector('#reasoning-mode')?.value==='high'&&!document.querySelector('#reasoning-mode')?.disabled);
 assert(await select.inputValue()==='high','Mode lost on browser reload');await page.screenshot({path:'/opt/vibe-os/platform/evidence/portal-ui/reasoning.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)),'Mobile overflow');
 await page.screenshot({path:'/opt/vibe-os/platform/evidence/portal-ui/mobile-reasoning.png',fullPage:true});checks.push('four UI choices; persisted change; cold reload; mobile layout');
 await context.close();
 const after=budget();assert(after.attempts===before.attempts&&after.confirmed_tokens===before.confirmed_tokens,'Unexpected paid call');
 assert(errors.length===0,'Browser errors');
 writeFileSync('/opt/vibe-os/platform/evidence/reasoning-free-acceptance.json',JSON.stringify({passed:true,checks,paidCalls:0,budgetBefore:before,budgetAfter:after,errors},null,2)+'\n');
 console.log(JSON.stringify({passed:true,checks:checks.length,paidCalls:0}));
}finally{
 if(browser)await browser.close();
 if(project)await api('DELETE','/projects/'+project,{});
 if(cookie)await api('POST','/auth/logout',{});
}
