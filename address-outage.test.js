import test from 'node:test';
import assert from 'node:assert/strict';
import {khmelnytskyiOutage,odesaOutage,powerOnOutage} from './address-lookup.js';

test('DTEK type 2 needs an explicit emergency reason',()=>{
 const event={type:'2',start_date:'11:39 15.01.2026',end_date:'22:25 15.01.2026'};
 assert.deepEqual(odesaOutage({...event,sub_type:'Аварійні ремонтні роботи'}),{
  status:'active',reason:'Аварійні ремонтні роботи',startedAt:event.start_date,estimatedRestoration:event.end_date});
 assert.equal(odesaOutage({...event,sub_type:'Екстренні відключення'}).status,'active');
 assert.equal(odesaOutage({...event,sub_type:'Стабілізаційне відключення (Згідно графіку погодинних відключень)'}).status,'no_emergency');
 assert.equal(odesaOutage({...event,sub_type:''}).status,'unavailable');
 assert.equal(odesaOutage({...event,type:'1'}).status,'no_emergency');
 assert.equal(odesaOutage({type:'',sub_type:'',start_date:'',end_date:''}).status,'no_emergency');
 assert.equal(odesaOutage({...event,cek:true}).status,'unavailable');
});

test('Khmelnytskyi distinguishes local repair from schedule rows marked emergency',()=>{
 const table=rows=>'<table class="table-post-list table-shutdowns"><tr><th>Вид робіт</th></tr>'+
  rows.map(row=>'<tr>'+row.map(value=>'<td>'+value+'</td>').join('')+'</tr>').join('')+'</table>';
 const schedule=['Графік погодинних відключень','Аварійне','6.1','-','23.11.2026 13:00','23.11.2026 17:11'];
 const repair=['Аварійні','Аварійне','6.1','-','23.11.2026 13:07','23.11.2026 19:07'];
 assert.equal(khmelnytskyiOutage(table([schedule])).status,'no_emergency');
 assert.deepEqual(khmelnytskyiOutage(table([schedule,repair])),{status:'active',
  reason:'Аварійні роботи',startedAt:repair[4],estimatedRestoration:repair[5]});
 assert.equal(khmelnytskyiOutage('<div>Service unavailable</div>').status,'unavailable');
});

test('street outage feeds match exact houses and collapse identical operator records',()=>{
 const row={typeOff:1,switchSubReason:0,buildingNames:'11-А, 7',dateEvent:'2026-11-23T13:48:04+02:00'};
 assert.equal(powerOnOutage([row,{...row,id:2}],'11а').status,'active');
 assert.equal(powerOnOutage([row],'11').status,'no_emergency');
 assert.equal(powerOnOutage([{...row,switchSubReason:2}],'7').status,'no_emergency');
 assert.equal(powerOnOutage([{...row,buildingNames:'1–20'}],'7').status,'unavailable');
});
