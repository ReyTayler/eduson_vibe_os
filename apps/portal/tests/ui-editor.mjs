
/** Browser acceptance of student CRUD with disposable account-two fixtures; no AI prompts. */
import {chromium} from 'playwright';
import {readFileSync,writeFileSync} from 'node:fs';
const origin='https://80.249.145.94',out='/opt/vibe-os/platform/evidence/portal-ui';
const account=JSON.parse(readFileSync('/var/lib/vibe-os/portal-private/student-logins.json'))[1];
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
let project,folder;
function assert(value,text){if(!value)throw new Error(text)}
async function dialog(value){
 const d=page.getByRole('dialog');await d.getByRole('textbox').fill(value);
 await d.getByRole('button',{name:'Сохранить',exact:true}).click();
 await d.waitFor({state:'hidden'});
}
try{
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.getByLabel('Логин',{exact:true}).fill(account.login);await page.getByLabel('Пароль',{exact:true}).fill(account.password);
 await page.getByRole('button',{name:'Войти в пространство'}).click();await page.getByRole('heading',{name:'Идеям здесь просторно.'}).waitFor();
 assert(await page.locator('.project-card').count()===0,'Second account not empty');checks.push('empty private cabinet');
 await page.screenshot({path:out+'/empty-cabinet.png',fullPage:true});
 await page.locator('.sidebar nav button').filter({hasText:'Проекты'}).click();
 await page.getByRole('button',{name:'Новая папка',exact:true}).click();
 const folderResponse=page.waitForResponse(r=>r.url().endsWith('/api/folders')&&r.request().method()==='POST');
 await dialog('Временная проверка интерфейса');folder=(await (await folderResponse).json()).id;checks.push('create folder');
 await page.locator('.topbar').getByRole('button',{name:'Новый проект'}).click();
 const modal=page.getByRole('dialog');await modal.getByLabel('Название проекта').fill('Временная проверка редактора');
 await modal.getByRole('button',{name:'JavaScript Программы на Node'}).click();
 await modal.getByLabel('Папка',{exact:true}).selectOption(folder);
 for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert(await page.evaluate(()=>Boolean(document.activeElement.closest('[role="dialog"]'))),'Modal focus escaped')}
 await page.screenshot({path:out+'/new-project.png',fullPage:true});
 const projectResponse=page.waitForResponse(r=>r.url().endsWith('/api/projects')&&r.request().method()==='POST');
 await modal.getByRole('button',{name:'Создать проект',exact:true}).click();project=(await (await projectResponse).json()).id;
 await modal.waitFor({state:'hidden'});await page.locator('.cm-editor').waitFor();
 checks.push('create Node project in selected folder and modal focus containment');
 await page.getByRole('button',{name:'Создать директорию',exact:true}).click();await dialog('src');
 await page.getByRole('button',{name:'Создать файл',exact:true}).click();await dialog('src/demo.py');
 const editor=page.locator('.cm-content');await editor.click();await page.keyboard.press('Control+a');await page.keyboard.insertText('print("UI_EDITOR_SAVE_OK")\n');
 await page.keyboard.press('Control+s');await page.getByText('Всё сохранено',{exact:true}).waitFor();await page.getByRole('button',{name:'Запустить',exact:true}).click();
 await page.locator('.console-panel pre').filter({hasText:'UI_EDITOR_SAVE_OK'}).waitFor();checks.push('directory and nested file creation; Ctrl+S; real execution');
 await page.getByRole('button',{name:'Действия: src',exact:true}).click();await page.locator('.tree-dropdown').getByRole('button',{name:'Переименовать'}).click();await dialog('code');
 await page.getByRole('button',{name:'Переименовать файл',exact:true}).click();await dialog('code/hello.py');
 assert((await page.locator('.cm-content').textContent()).includes('UI_EDITOR_SAVE_OK'),'Rename lost editor content');checks.push('rename directory and active file preserves content');
 await page.getByRole('button',{name:'Новый чат',exact:true}).click();await page.getByRole('button',{name:'Переименовать чат'}).click();await dialog('Мои будущие идеи');
 assert((await page.getByLabel('Выбрать чат').locator('option:checked').textContent()).trim()==='Мои будущие идеи','Renamed chat not selected');checks.push('create and rename chat');
 await page.screenshot({path:out+'/editor-crud.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)),'Mobile editor horizontal overflow');
 await page.screenshot({path:out+'/mobile-editor.png',fullPage:true});checks.push('mobile editor layout');
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Удалить файл',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Продолжить',exact:true}).click();
 await page.getByTitle('code/hello.py',{exact:true}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'Действия: code',exact:true}).click();await page.locator('.tree-dropdown').getByRole('button',{name:'Удалить'}).click();await page.getByRole('dialog').getByRole('button',{name:'Продолжить',exact:true}).click();
 await page.getByRole('button',{name:'Действия: code',exact:true}).waitFor({state:'detached'});checks.push('delete file and empty directory from UI');
 await page.locator('.sidebar nav button').filter({hasText:'Разговоры'}).click();await page.screenshot({path:out+'/chats.png',fullPage:true});
 await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('heading',{name:'Всё на своих местах'}).waitFor();
 const originalName=await page.getByLabel('Имя в кабинете').inputValue();await page.getByLabel('Имя в кабинете').fill(originalName);await page.getByRole('button',{name:'Сохранить изменения',exact:true}).click();await page.getByText('Профиль сохранён',{exact:true}).waitFor();
 await page.screenshot({path:out+'/settings.png',fullPage:true});checks.push('chat overview and profile settings');
 assert(errors.length===0,'Browser errors: '+errors.join(';'));
}finally{
 let cookie='',csrf='';
 async function call(method,path,body){
  const res=await fetch(origin+'/api'+path,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  const data=await res.json();assert(res.status===200,'Fixture cleanup failed '+res.status+' '+data.error);return data;
 }
 await call('POST','/auth/login',{login:account.login,password:account.password});csrf=(await call('GET','/me')).csrf;
 if(project)await call('DELETE','/projects/'+project,{});
 if(folder)await call('DELETE','/folders/'+folder,{});
 assert((await call('GET','/projects')).length===0&&(await call('GET','/folders')).length===0,'Second cabinet not restored empty');
 await call('POST','/auth/logout',{});
 await context.close();await browser.close();
}
writeFileSync('/opt/vibe-os/platform/evidence/student-ui-editor.json',JSON.stringify({passed:true,checks,count:checks.length,browserErrors:errors,paidCalls:0,fixturesRemoved:true},null,2)+'\n');
console.log(JSON.stringify({passed:true,checks:checks.length,paidCalls:0,fixturesRemoved:true}));
