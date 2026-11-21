import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTelegram} from './telegram.js';
import {buildScheduleHtml} from './schedule-image.js';
import {changedRanges} from './public/dates.js';

test('adjacent changed slots share outlines by state on graph images',()=>{
 const slots=[true,false,false,true,false,null];
 const before=Array(6).fill(true);
 assert.deepEqual(changedRanges(slots,before),[{start:1,end:3,state:false},{start:4,end:5,state:false},{start:5,end:6,state:null}]);
 assert.deepEqual(changedRanges(slots,null),[]);
 const html=buildScheduleHtml({day:{date:'2026-11-14',groups:{'1.1':slots}},previousDay:{groups:{'1.1':before}}});
 assert.equal((html.match(/class="change-outline /g)||[]).length,3);
 assert.match(html,/change-added[^}]+#ff727d/);
 assert.doesNotMatch(html,/dashed/);
});

const fixedNow=new Date('2026-11-13T17:15:00Z');
const day=(date='2026-11-13',off=false)=>({date,groups:{'1.1':Array(48).fill(!off),'2.1':Array(48).fill(true)}});
const snapshot=()=>({region:'o',current:{days:[day(),day('2026-11-14')]},previous:null});
const incoming=(id,text,chat=42)=>({update_id:id,message:{chat:{id:chat,type:'private'},text}});

test('regional alerts and graph requests stay within the selected region',async t=>{
 const f=await setup(t,{getSnapshot:region=>({...snapshot(),region})});
 f.setUpdates([incoming(1,'/group 1.1',42),incoming(2,'/region k',43),incoming(3,'/group 1.1',43)]);
 await f.bot.pollOnce({timeout:0});
 assert.deepEqual(f.images.map(image=>image.region),['o','o','k','k']);
 f.calls.length=0;
 const before={...snapshot(),region:'k',emergency:{active:false}};
 await f.bot.notify(before,{...before,emergency:{active:true,kind:'unplanned',message:'Оголошення київського оператора'}});
 await f.bot.flush();
 assert.deepEqual(f.calls.filter(call=>call.method==='sendMessage').map(call=>call.payload.chat_id),['43']);
});

test('reminders follow per-location settings, skip continuations and survive restart without duplicates',async t=>{
 const instant=new Date('2026-11-13T17:15:15Z'); // 19:15 Kyiv
 const monitor=day();
 monitor.groups['1.1'].fill(false,39,42);
 monitor.groups['2.1'].fill(false,38,42);
 const f=await setup(t,{now:()=>instant,getSnapshot:region=>({region,current:{days:[monitor]}})});
 f.setUpdates([incoming(1,'/group 1.1'),incoming(2,'/reminder 15'),incoming(3,'/reminder_add Робота | k | 2.1')]);
 await f.bot.pollOnce({timeout:0});
 f.calls.length=0;
 await f.bot.tickReminders();
 const restarted=await createTelegram(f.base);t.after(()=>restarted.stop());
 await restarted.tickReminders();
 const messages=f.calls.filter(call=>call.method==='sendMessage');
 assert.equal(messages.length,1);
 assert.match(messages[0].payload.text,/Основна.*1\.1\n.*19:30/);
});

test('reminder menu toggles times, accepts a custom reply and inherits per location',async t=>{
 const f=await setup(t);
 const click=(id,data)=>({update_id:id,callback_query:{id:'rem-'+id,data:'rem:'+data,
  message:{chat:{id:42,type:'private'},message_id:77}}});
 const step=async(...updates)=>{f.setUpdates(updates);await f.bot.pollOnce({timeout:0});};
 const sub=async()=>JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8')).subscriptions[42];
 await step(incoming(1,'/reminder'),click(2,'all:off:60'),click(3,'all:off:15'),click(4,'home:on:custom'));
 const prompt=f.calls.findLast(call=>call.method==='sendMessage'&&call.payload.reply_markup?.force_reply).payload.text;
 const reply=incoming(5,'20, 7');
 reply.message.reply_to_message={text:prompt,from:{is_bot:true}};
 await step(reply);
 assert.deepEqual((await sub()).reminderLead,[60,15]);
 assert.deepEqual((await sub()).primaryRestore,[20,7]);
 await step(click(6,'home:on:inherit'),click(7,'all:off:15'),click(8,'add:k:2.1'));
 assert.equal((await sub()).primaryRestore,undefined);
 assert.deepEqual((await sub()).reminderLead,[60]);
 const name=incoming(9,'Робота');
 name.message.reply_to_message={text:(await sub()).reminderInput.prompt,from:{is_bot:true}};
 await step(name);
 const [place]=(await sub()).reminderPlaces;
 assert.equal(place.name,'Робота');
 assert.equal(place.group,'2.1');
 await step(click(10,place.id+':remove:yes'));
 assert.deepEqual((await sub()).reminderPlaces,[]);
});

test('address lookup suggests a queue without changing the saved subscription until confirmed',async t=>{
 const f=await setup(t,{lookupAddress:async()=>({groups:['2.1']})});
 f.setUpdates([incoming(1,'/group 1.1'),incoming(2,'/address Місто | Вулиця | 1')]);
 await f.bot.pollOnce({timeout:0});
 const state=()=>readFile(join(f.dir,'telegram.json'),'utf8').then(JSON.parse);
 assert.deepEqual((await state()).subscriptions[42].groups,['1.1']);
 f.setUpdates([{update_id:3,callback_query:{id:'address',data:'address:o:2.1',
  message:{chat:{id:42,type:'private'},message_id:77}}}]);
 await f.bot.pollOnce({timeout:0});
 assert.deepEqual((await state()).subscriptions[42].groups,['2.1']);
});

test('delivers two outage leads and a silent restoration without repeats',async t=>{
 let instant=new Date('2026-11-13T16:30:15Z');
 const monitor=day();
 monitor.groups['1.1'].fill(false,39,42);
 const f=await setup(t,{now:()=>instant,getSnapshot:()=>({current:{days:[monitor]}})});
 f.setUpdates([incoming(1,'/group 1.1'),incoming(2,'/reminder 60,15,15'),
  incoming(3,'/restore 15 0'),{update_id:4,callback_query:{id:'setting',
   data:'notify:restoration:silent',message:{chat:{id:42,type:'private'},message_id:77}}}]);
 await f.bot.pollOnce({timeout:0});
 f.calls.length=0;
 for(const time of ['16:30:15','17:15:15','18:45:15']){
  instant=new Date(`2026-11-13T${time}Z`);
  await f.bot.tickReminders();
  await f.bot.tickReminders();
 }
 const messages=f.calls.filter(call=>call.method==='sendMessage').map(call=>call.payload);
 assert.equal(messages.length,3);
 assert.match(messages[0].text,/світла не буде з 19:30/);
 assert.match(messages[1].text,/світла не буде з 19:30/);
 assert.match(messages[2].text,/світло відновлять з 21:00/);
 assert.equal(messages[2].disable_notification,true);
});
async function setup(t,options={}) {
 const dir=await mkdtemp(join(tmpdir(),'dtek-telegram-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let updates=[],failure=null;
 const calls=[],images=[];
 const fetchImpl=async(url,request)=>{
  const method=url.split('/').at(-1);
  const payload=request.body instanceof FormData?Object.fromEntries(request.body.entries()):JSON.parse(request.body);
  calls.push({method,payload});
  if(method==='getUpdates'){const result=updates;updates=[];return {ok:true,json:async()=>({ok:true,result})};}
  if(failure&&failure.method===method)return {ok:false,status:failure.code,json:async()=>({ok:false,error_code:failure.code,parameters:{retry_after:failure.retryAfter}})};
  if(method==='getChatAdministrators')return {ok:true,json:async()=>({ok:true,result:[{status:'creator',user:{id:10}}]})};
  return {ok:true,json:async()=>({ok:true,result:method==='getMe'?{username:'test_bot'}:{message_id:1}})};
 };
 const base={token:'test-token',dataDir:dir,getSnapshot:snapshot,fetchImpl,renderImage:async options=>{images.push(options);return Buffer.from('png');},now:()=>fixedNow,chatIds:'',initialGroups:'',...options};
 const bot=await createTelegram(base);t.after(()=>bot.stop());
 return {bot,dir,calls,images,base,setUpdates:value=>{updates=value;},setFailure:value=>{failure=value;}};
}

test('notification preferences silence photos and suppress operator alerts without affecting manual requests',async t=>{
 const f=await setup(t);
 const click=(id,data)=>({update_id:id,callback_query:{id:`settings-${id}`,data,message:{chat:{id:42,type:'private'},message_id:77}}});
 f.setUpdates([incoming(1,'/group 1.1'),incoming(2,'/notifications'),click(3,'notify:schedule:silent'),click(4,'notify:unplanned:off')]);
 await f.bot.pollOnce({timeout:0});
 assert.ok(f.calls.some(call=>call.method==='editMessageText'&&call.payload.reply_markup.inline_keyboard
  .some(([button])=>button.callback_data==='notify:schedule:off')));
 f.calls.length=0;
 await f.bot.notify(snapshot(),{...snapshot(),current:{days:[day('2026-11-13',true)]},
  emergency:{active:true,kind:'unplanned',message:'Зникло світло'}});
 await f.bot.flush();
 assert.deepEqual(f.calls.filter(call=>call.method==='sendPhoto').map(call=>call.payload.disable_notification),['true']);
 assert.equal(f.calls.some(call=>call.method==='sendMessage'),false);
 f.calls.length=0;
 f.setUpdates([incoming(5,'/schedule')]);
 await f.bot.pollOnce({timeout:0});
 assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,2);
 assert.ok(f.calls.filter(call=>call.method==='sendPhoto').every(call=>call.payload.disable_notification===undefined));
});

test('group members can request graphs but only current admins can change the shared queue',async t=>{
 const f=await setup(t);
 const chat={id:-123,type:'supergroup'};
 const msg=(id,user,text)=>({update_id:id,message:{chat,from:{id:user},text}});
 const click=(id,user,data)=>({update_id:id,callback_query:{id:`cb-${id}`,from:{id:user},data,message:{chat,message_id:99}}});
 f.setUpdates([msg(1,11,'/group 2.1'),msg(2,10,'/group'),click(3,11,'group:o:2.1'),click(4,10,'group:o:1.1')]);
 await f.bot.pollOnce({timeout:0});
 assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,1);
 assert.ok(f.calls.find(c=>c.method==='answerCallbackQuery'&&c.payload.show_alert));
 assert.deepEqual(f.images.map(i=>i.selectedGroups),[['1.1'],['1.1']]);
 f.setFailure({method:'getChatAdministrators',code:503});
 f.setUpdates([msg(5,10,'/group 2.1'),msg(6,11,'/stop'),msg(7,11,'2.1'),msg(8,11,'/schedule'),msg(9,11,'/schedule')]);
 await f.bot.pollOnce({timeout:0});
 assert.equal(f.images.length,4);
 const saved=JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8'));
 assert.deepEqual(saved.subscriptions['-123'].groups,['1.1']);
 assert.equal(saved.subscriptions['-123'].enabled,true);
});

test('shared chat switches operator queues and rejects buttons from the previous region',async t=>{
 const kyiv={region:'k',current:{days:[{date:'2026-11-13',groups:{'60.1':Array(48).fill(true)}}],retainedDates:['2026-11-13']}};
 const f=await setup(t,{getSnapshot:region=>region==='k'?kyiv:snapshot()});
 const chat={id:-456,type:'supergroup'};
 const msg=(id,user,text)=>({update_id:id,message:{chat,from:{id:user},text}});
 const click=(id,data)=>({update_id:id,callback_query:{id:`cb-${id}`,from:{id:10},data,message:{chat,message_id:99}}});
 f.setUpdates([msg(1,11,'/region k'),msg(2,10,'/region k'),click(3,'group:o:1.1'),click(4,'group:k:60.1'),msg(5,11,'/schedule')]);
 await f.bot.pollOnce({timeout:0});
 assert.ok(f.calls.some(c=>c.method==='sendMessage'&&c.payload.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data==='group:k:60.1')));
 assert.ok(f.calls.some(c=>c.method==='answerCallbackQuery'&&c.payload.callback_query_id==='cb-3'&&c.payload.show_alert));
 assert.deepEqual(f.images.map(i=>[i.region,i.selectedGroups]),[['k',['60.1']],['k',['60.1']]]);
 assert.ok(f.calls.filter(c=>c.method==='sendPhoto').every(c=>/Київ.*60\.1[\s\S]*Збережений графік/u.test(c.payload.caption)));
});

test('Telegram is inert when no token is configured',async()=>{
 const bot=await createTelegram({token:'',fetchImpl:()=>{throw Error('must not fetch');}});
 assert.equal(bot.enabled,false);assert.equal(bot.getUsername(),null);
 bot.start();await bot.notify(null,snapshot());await bot.stop();
});

test('bot username recovers after a failed startup identity request without restart',async t=>{
 const f=await setup(t,{identityRetryMs:1});
 f.setFailure({method:'getMe',code:503});
 f.bot.start();
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(f.bot.getUsername(),null);
 f.setFailure(null);
 await new Promise(resolve=>setTimeout(resolve,1100));
 assert.equal(f.bot.getUsername(),'test_bot');
 assert.equal(f.calls.filter(call=>call.method==='getMe').length,2);
 await f.bot.stop();
});

test('first start prompts group, selection persists with update offset across restart',async t=>{
 const f=await setup(t);
 f.setUpdates([incoming(100,'/start')]);await f.bot.pollOnce({timeout:0});
 assert.equal(f.images.length,0);
 assert.match(f.calls.find(call=>call.method==='sendMessage').payload.text,/Оберіть свою групу/);
 assert.equal(f.calls.find(call=>call.method==='sendMessage').payload.reply_markup.inline_keyboard[0][0].callback_data,'group:1.1');
 assert.equal(f.calls.find(call=>call.method==='sendMessage').payload.reply_markup.keyboard,undefined);
 f.setUpdates([incoming(101,'1.1')]);await f.bot.pollOnce({timeout:0});
 assert.equal(f.images.length,2);assert.deepEqual(f.images[0].selectedGroups,['1.1']);
 assert.deepEqual(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.reply_markup,{remove_keyboard:true});
 const saved=JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8'));
 assert.deepEqual(saved.subscriptions['42'].groups,['1.1']);assert.equal(saved.offset,102);
 assert.equal(JSON.stringify(saved).includes('test-token'),false);
 const restarted=await createTelegram(f.base);t.after(()=>restarted.stop());
 f.setUpdates([incoming(101,'2.1')]);await restarted.pollOnce({timeout:0});
 assert.equal(f.calls.filter(call=>call.method==='getUpdates').at(-1).payload.offset,102);
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8')).subscriptions['42'].groups,['1.1']);
});

test('remembered group stays selected without reopening keyboard on start or schedule',async t=>{
 const f=await setup(t,{chatIds:'42',initialGroups:'1.1'});
 f.setUpdates([incoming(1,'/start')]);await f.bot.pollOnce({timeout:0});
 const greeting=f.calls.find(call=>call.method==='sendMessage');
 assert.match(greeting.payload.text,/Ваша група: 1\.1/);
 assert.deepEqual(greeting.payload.reply_markup,{remove_keyboard:true});
 assert.equal(f.calls.some(call=>call.payload.reply_markup?.keyboard),false);
 f.calls.length=0;
 f.setUpdates([incoming(2,'/schedule')]);await f.bot.pollOnce({timeout:0});
 assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,2);
 assert.equal(f.calls.some(call=>call.payload.reply_markup?.keyboard),false);
 f.calls.length=0;
 f.setUpdates([incoming(3,'/group')]);await f.bot.pollOnce({timeout:0});
 const chooser=f.calls.find(call=>call.method==='sendMessage');
 assert.ok(chooser.payload.reply_markup.inline_keyboard);
 assert.equal(chooser.payload.reply_markup.keyboard,undefined);
});

test('inline group selection acknowledges callback, removes chooser and persists selection before photos',async t=>{
 const f=await setup(t);
 f.setUpdates([incoming(1,'/start')]);await f.bot.pollOnce({timeout:0});
 f.calls.length=0;
 f.setUpdates([{update_id:2,callback_query:{id:'callback-one',data:'group:1.1',message:{message_id:77,chat:{id:42,type:'private'}}}}]);
 await f.bot.pollOnce({timeout:0});
 const outgoing=f.calls.filter(call=>call.method!=='getUpdates');
 assert.deepEqual(outgoing.map(call=>call.method),['answerCallbackQuery','editMessageText','sendPhoto','sendPhoto']);
 assert.equal(outgoing[0].payload.callback_query_id,'callback-one');
 assert.equal(outgoing[1].payload.message_id,77);
 assert.deepEqual(outgoing[1].payload.reply_markup,{inline_keyboard:[]});
 assert.match(outgoing[1].payload.text,/Збережено: група 1\.1/);
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8')).subscriptions['42'].groups,['1.1']);
 assert.equal(outgoing.some(call=>call.payload.reply_markup?.keyboard),false);
});

test('inline all-groups selection is saved and chooser has no input keyboard',async t=>{
 const f=await setup(t);
 f.setUpdates([{update_id:1,callback_query:{id:'callback-all',data:'group:all',message:{message_id:78,chat:{id:42,type:'private'}}}}]);
 await f.bot.pollOnce({timeout:0});
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8')).subscriptions['42'].groups,[]);
 assert.deepEqual(f.calls.find(call=>call.method==='editMessageText').payload.reply_markup,{inline_keyboard:[]});
 assert.deepEqual(f.images[0].selectedGroups,[]);
});

test('changed schedules send photos only to chats selecting affected groups',async t=>{
 const f=await setup(t);
 f.setUpdates([incoming(1,'/group 1.1',42),incoming(2,'/group 2.1',43)]);await f.bot.pollOnce({timeout:0});
 f.calls.length=0;f.images.length=0;
 const before=snapshot();const after=snapshot();after.current.days[0]=day('2026-11-13',true);
 await f.bot.notify(before,after);await f.bot.flush();
 assert.deepEqual(f.calls.filter(call=>call.method==='sendPhoto').map(call=>call.payload.chat_id),['42']);
 assert.equal(f.images.length,1);assert.deepEqual(f.images[0].selectedGroups,['1.1']);
 assert.deepEqual(f.images[0].previousDay,before.current.days[0]);
 assert.match(f.calls.find(c=>c.method==='sendPhoto').payload.caption,/Графік оновлено.*13-11-2026\nЗмінилися черги: 1\.1/u);
});

test('first publication of tomorrow uses its own caption and date format',async t=>{
 const f=await setup(t);
 f.setUpdates([incoming(1,'/group 1.1')]);await f.bot.pollOnce({timeout:0});
 assert.match(f.calls.find(c=>c.method==='sendPhoto').payload.caption,/13-11-2026/);
 f.calls.length=0;
 const before={region:'o',current:{days:[day()]}};
 await f.bot.notify(before,snapshot());await f.bot.flush();
 const captions=f.calls.filter(c=>c.method==='sendPhoto').map(c=>c.payload.caption);
 assert.deepEqual(captions,['⚡ Додано графік на 14-11-2026 · Одеса та область']);
});

test('/stop clears queued schedules, disables future notifications, and /start restores selection',async t=>{
 const f=await setup(t);f.setUpdates([incoming(1,'/group 1.1')]);await f.bot.pollOnce({timeout:0});
 f.setFailure({method:'sendPhoto',code:429,retryAfter:60});
 await f.bot.notify(snapshot(),{current:{days:[day('2026-11-13',true)]}});await f.bot.flush();
 assert.equal(JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8')).queue.length,1);
 f.setUpdates([incoming(2,'/stop')]);await f.bot.pollOnce({timeout:0});
 const stopped=JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8'));
 assert.equal(stopped.subscriptions['42'].enabled,false);assert.deepEqual(stopped.queue,[]);
 f.setFailure(null);f.calls.length=0;
 await f.bot.notify(snapshot(),{current:{days:[day('2026-11-13',true)]}});await f.bot.flush();
 assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,0);
 f.setUpdates([incoming(3,'/start')]);await f.bot.pollOnce({timeout:0});
 assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,2);
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8')).subscriptions['42'].groups,['1.1']);
});

test('failed image delivery remains persisted and can retry after restart',async t=>{
 const f=await setup(t,{chatIds:'42',initialGroups:'1.1'});
 f.setFailure({method:'sendPhoto',code:429,retryAfter:60});
 await f.bot.notify(null,snapshot());await f.bot.flush();
 const path=join(f.dir,'telegram.json');const saved=JSON.parse(await readFile(path,'utf8'));
 assert.equal(saved.queue.length,2);assert.equal(saved.queue[0].attempts,1);
 saved.queue.forEach(event=>event.retryAt=0);await writeFile(path,JSON.stringify(saved));
 f.setFailure(null);f.calls.length=0;
 const restarted=await createTelegram(f.base);t.after(()=>restarted.stop());await restarted.flush();
 assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,2);
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')).queue,[]);
});

test('blocked users are disabled without blocking delivery to other subscribers',async t=>{
 const f=await setup(t,{chatIds:'42,43',initialGroups:'1.1'});
 f.setFailure({method:'sendPhoto',code:403});
 await f.bot.notify(null,snapshot());await f.bot.flush();
 const state=JSON.parse(await readFile(join(f.dir,'telegram.json'),'utf8'));
 assert.equal(state.subscriptions['42'].enabled,false);assert.equal(state.subscriptions['43'].enabled,false);
 assert.deepEqual(state.queue,[]);
 assert.deepEqual(f.calls.filter(call=>call.method==='sendPhoto').map(call=>call.payload.chat_id),['42','43']);
});

test('emergency status changes alert subscribers even when schedules are identical',async t=>{
 const f=await setup(t,{chatIds:'42',initialGroups:'1.1'});
 const before=snapshot(),after=snapshot();after.emergency={active:true,text:'Екстрені відключення: Одеський район.'};
 await f.bot.notify(before,after);await f.bot.flush();
 assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,0);
 assert.match(f.calls.find(call=>call.method==='sendMessage').payload.text,/Одеський район/);
});

test('cleared notices name the previous outage type',async t=>{
 const f=await setup(t,{chatIds:'42',initialGroups:'1.1'});
 for(const [kind,label] of [['unplanned','аварійні відключення'],['emergency','екстрені відключення'],['mixed','аварійні та екстрені відключення']]){
  const before={...snapshot(),emergency:{active:true,kind}};
  const after={...snapshot(),emergency:{active:false}};
  await f.bot.notify(before,after);await f.bot.flush();
  assert.ok(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text.includes(`зняв попередження: ${label} · Одеса та область`));
 }
});

test('emergency metadata-only changes, inactive updates and unknown status do not alert',async t=>{
 const f=await setup(t,{chatIds:'42',initialGroups:'1.1'});
 for(const [beforeAlert,nextAlert] of [
  [{active:true,text:'Екстрені відключення',areas:['Одеса'],checkedAt:'one'}, {active:true,text:'Екстрені відключення',areas:['Одеса'],checkedAt:'two',stale:true}],
  [{active:true,kind:'unplanned',message:'Зникло світло в частині Подільського району.',areas:['Подільського району']},
   {active:true,kind:'unplanned',text:'Зникло світло в частині Подільського\u200b району.',areas:[]}],
  [{active:false,text:'Попереднє повідомлення'},{active:false,text:'Інший текст',checkedAt:'two'}],
  [{active:true,text:'Екстрені відключення'},{active:null,text:'Статус невідомий'}]
 ]) {
  const before=snapshot(),after=snapshot();before.emergency=beforeAlert;after.emergency=nextAlert;
  await f.bot.notify(before,after);await f.bot.flush();
 }
 assert.equal(f.calls.filter(call=>call.method==='sendMessage'||call.method==='sendPhoto').length,0);
});

test('district outage alerts go to enabled subscribers without a selected schedule and are not repeated',async t=>{
 const f=await setup(t);
 f.setUpdates([incoming(1,'/start')]);await f.bot.pollOnce({timeout:0});
 f.calls.length=0;
 const before={...snapshot(),emergency:{active:false}};
 const after={...snapshot(),emergency:{active:true,kind:'unplanned',message:'Зникло світло в частині Подільського району.'}};
 await f.bot.notify(before,after);await f.bot.flush();
 await f.bot.notify(after,{...after,emergency:{...after.emergency,checkedAt:fixedNow.toISOString()}});await f.bot.flush();
 const messages=f.calls.filter(call=>call.method==='sendMessage');
 assert.equal(messages.length,1);
 assert.match(messages[0].payload.text,/Аварійні відключення.*\n.*Подільського/);
});

test('image HTML keeps unknown slots distinct, filters groups, and escapes source text',()=>{
 const current=day();current.groups['1.1'][47]=null;
 const html=buildScheduleHtml({day:current,selectedGroups:['1.1'],now:fixedNow,emergency:{active:true,text:'<script>alert(1)</script>'}});
 assert.match(html,/cell unknown/);assert.match(html,/неповні дані/);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.doesNotMatch(html,/>2\.1</);assert.match(html,/>1\.1</);
 assert.throws(()=>buildScheduleHtml({day:current,selectedGroups:['9.9']}));
});
