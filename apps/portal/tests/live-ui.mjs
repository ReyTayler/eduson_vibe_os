
import {chromium} from 'playwright'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
const account=JSON.parse(readFileSync('/var/lib/vibe-os/portal-private/student-logins.json'))[0]
const budget=()=>JSON.parse(execFileSync('/usr/local/bin/node',['/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs','status'])).budget
const before=budget()
if(before.limitTokens!==1000000||before.remainingAuthorizationTokens<4*65536)throw new Error('No authorized headroom')
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
let report
try{
 await page.goto('https://80.249.145.94/',{waitUntil:'networkidle'})
 await page.getByLabel('Логин',{exact:true}).fill(account.login);await page.getByLabel('Пароль',{exact:true}).fill(account.password)
 await page.getByRole('button',{name:'Войти в пространство'}).click();await page.getByRole('heading',{name:'Идеям здесь просторно.'}).waitFor()
 await page.getByRole('button',{name:'Открыть Моя первая идея'}).click();await page.locator('.cm-editor').waitFor()
 await page.getByRole('button',{name:'Новый чат',exact:true}).click()
 await page.getByRole('button',{name:'Переименовать чат'}).click()
 const modal=page.getByRole('dialog');await modal.getByRole('textbox').fill('Первые идеи для проекта');await modal.getByRole('button',{name:'Сохранить',exact:true}).click();await modal.waitFor({state:'hidden'})
 await page.getByLabel('Сообщение помощнику').fill('Создай новый файл NOTES.md в этом проекте. Запиши в него точно такой текст: "# Идеи для проекта\\n\\n1. Добавить красивую анимацию.\\n2. Придумать свою интерактивную кнопку.\\n". Используй write_file один раз. Не читай и не изменяй остальные файлы. После успешного сохранения коротко сообщи по-русски, что файл создан.')
 await page.getByRole('button',{name:'Отправить сообщение'}).click()
 await page.locator('.chat-message.assistant').waitFor({timeout:170000})
 await page.locator('.live-message').waitFor({state:'hidden',timeout:20000})
 await page.locator('.file-tree-row').filter({hasText:'NOTES.md'}).waitFor()
 const answer=await page.locator('.chat-message.assistant').last().innerText()
 if(!answer.includes('действий в проекте')&&!answer.includes('действия в проекте')&&!answer.includes('действий'))throw new Error('No durable real tool action card')
 await page.screenshot({path:'/opt/vibe-os/platform/evidence/portal-ui/live-harness.png',fullPage:true})
 await page.reload({waitUntil:'networkidle'})
 await page.getByRole('button',{name:'Открыть Моя первая идея'}).click();await page.locator('.cm-editor').waitFor()
 await page.getByLabel('Выбрать чат').selectOption({label:'Первые идеи для проекта'})
 await page.locator('.chat-message.assistant').waitFor()
 await page.locator('.file-tree-row').filter({hasText:'NOTES.md'}).click()
 await page.locator('.cm-content').filter({hasText:'Добавить красивую анимацию.'}).waitFor()
 const after=budget()
 if(after.confirmed_tokens<=before.confirmed_tokens||after.debitedTokens>1000000||after.attempts-before.attempts>4||after.uncertain_ceiling!==0)throw new Error('Live budget or settlement unexpected')
 report={suite:'student-ui-real-harness-cycle',passed:true,checks:['student-login','new-chat','rename-chat','real-deepseek','real-scoped-write-tool','durable-assistant','created-file','cold-ui-reload','persisted-chat','persisted-file','global-million-token-cap'],budgetBefore:before,budgetAfter:after,answer:answer.slice(0,600),browserErrors:errors}
 console.log(JSON.stringify({passed:true,newPaidCalls:after.attempts-before.attempts,newTokens:after.confirmed_tokens-before.confirmed_tokens,confirmedTotal:after.confirmed_tokens,limit:after.limitTokens}))
}catch(e){report={passed:false,error:e.message,budgetBefore:before,budgetAfter:budget()};console.error(e.message);process.exitCode=1}
finally{writeFileSync('/opt/vibe-os/platform/evidence/student-live-harness.json',JSON.stringify(report,null,2)+'\n');await browser.close()}
