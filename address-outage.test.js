import test from 'node:test';
import assert from 'node:assert/strict';
import {odesaOutage} from './address-lookup.js';

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
