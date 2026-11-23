import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmEmergency,extractEmergency} from './emergency.js';

const page=body=>`<html><main class="discon_schedule">${body}</main><script>DisconSchedule.fact = {"data":{}}; if ($('#modal-attention').length) MicroModal.show('modal-attention');</script></html>`;
const modal=body=>`<div id="modal-attention" class="modal" aria-hidden="true"><div class="modal__container"><h2>Увага!</h2><div class="modal__body">${body}</div><button>Закрити</button></div></div>`;

test('conservation advice does not declare emergency outages or hide a real announcement',()=>{
 const advice='Шановні клієнти! За наказом НЕК Укренерго сьогодні діють стабілізаційні відключення електроенергії. Будь ласка, розумно споживайте електроенергію — це допоможе зменшити навантаження на мережу та уникнути екстрених відключень.';
 assert.equal(extractEmergency(page(modal(advice))).active,false);
 assert.equal(extractEmergency(page(modal(advice.replace('розумно','економно')))).active,false);
 const active=extractEmergency(page(modal('В Одесі введено екстрені відключення. '+advice)));
 assert.equal(active.active,true);
 assert.equal(active.kind,'emergency');
 assert.equal(extractEmergency(page(modal('Допоможіть запобігти аварійним відключенням.'))).active,false);
});

test('recognizes a district outage without an explicit emergency keyword',()=>{
 const notice='Через пошкодження мережі зникло світло в частині <strong>Подільського</strong> району області. Фахівці працюють над відновленням.';
 const alert=extractEmergency(page(modal(notice)));
 assert.equal(alert.active,true);
 assert.equal(alert.kind,'unplanned');
 assert.deepEqual(alert.areas,['частині Подільського району']);
 assert.equal(extractEmergency(page(modal(notice+' Електропостачання відновлено.'))).active,false);
});

test('does not mistake FAQ, scripts, templates or standard schedule hints for a current emergency',()=>{
 const body='<p>Чим відрізняються екстрені відключення?</p><div class="discon-schedule-alert">Екстрені відключення</div><template>'+modal('Екстрені відключення')+'</template><div id="modal-attention" hidden>Екстрені відключення</div><script>const sample = '+JSON.stringify(modal('Екстрені відключення'))+';</script>';
 assert.deepEqual(extractEmergency(page(body)),{active:false,message:null,areas:[]});
});

test('extracts published attention announcement and preserves district text',()=>{
 const result=extractEmergency(page(modal('<p>У <strong>Одеському та Подільському районах</strong> введені екстрені відключення.</p><p>Графіки не діють.&nbsp;Стежте за повідомленнями.</p>')));
 assert.equal(result.active,true);
 assert.equal(result.message,'Увага! У Одеському та Подільському районах введені екстрені відключення. Графіки не діють. Стежте за повідомленнями.');
 assert.deepEqual(result.areas,['Одеському та Подільському районах']);
 assert.doesNotMatch(result.message,/Закрити/);
});

test('non-emergency announcements and explicit cancellation do not activate the banner',()=>{
 for(const text of ['Тривають технічні роботи на сайті.','Екстрені відключення скасовано.','Скасовано екстрені відключення.','Екстрені відключення не застосовуються.','Відбій екстрених відключень.']) {
  assert.equal(extractEmergency(page(modal(text))).active,false);
 }
});

test('unknown or truncated response is not treated as a confirmed clear status',()=>{
 for(const html of ['', '<html>Access denied</html>', '<div id="modal-attention"><p>Екстрені відключення']) {
  assert.equal(extractEmergency(html).active,null);
 }
});

test('cancellation for one district never hides an active declaration for another',()=>{
 for(const text of [
  'У Одеському районі введені екстрені відключення, у Подільському районі екстрені відключення скасовано.',
  'Екстрені відключення скасовано у Подільському районі. У Одеському районі введено екстрені відключення.',
  'У Подільському районі скасовано екстрені відключення; у Одеському районі відключення тривають.',
  'У Одеському районі екстрені відключення тривають, але у Подільському районі скасовано екстрені відключення.'
 ]) {
  const result=extractEmergency(page(modal(text)));
  assert.equal(result.active,true,text);
  assert.ok(result.message.includes(text));
 }
});

test('restored scheduled operation does not look like an active emergency declaration',()=>{
 assert.equal(extractEmergency(page(modal('Екстрені відключення скасовано. Графіки знову діють.'))).active,false);
});

test('decodes numeric entities and excludes hidden template copy',()=>{
 const result=extractEmergency(page(modal('<p>Екстрені відключення в Одесі &#8212; графіки не діють.</p><p hidden>Старий текст</p><p style="display: none">Інший район</p>')));
 assert.equal(result.message,'Увага! Екстрені відключення в Одесі — графіки не діють.');
});
test('operator notice changes and clearances require two matching reads',()=>{
 const now='2026-11-23T14:00:00Z';
 const active={active:true,kind:'emergency',message:'В Одесі діють екстрені відключення.',areas:[]};
 const clear={active:false,message:null,areas:[]};
 const hold=confirmEmergency(active,null,clear,now);
 assert.equal(hold.emergency.active,true);
 assert.equal(hold.emergency.stale,true);
 assert.equal(confirmEmergency(active,hold.candidate,clear,now).emergency.active,false);
 assert.equal(confirmEmergency(active,hold.candidate,{active:null},now).candidate,null);
 const echo={...active,message:'«В Одесі діють екстрені відключення.» — сайт ДТЕК'};
 const same=confirmEmergency(active,hold.candidate,echo,now);
 assert.equal(same.emergency.message,active.message);
 assert.equal(same.emergency.stale,false);
 assert.equal(same.candidate,null);
 const unplanned={active:true,kind:'unplanned',message:'У частині району зникло світло.'};
 const changed=confirmEmergency(active,null,unplanned,now);
 assert.equal(changed.emergency.kind,'emergency');
 assert.equal(confirmEmergency(active,changed.candidate,unplanned,now).emergency.kind,'unplanned');
});
