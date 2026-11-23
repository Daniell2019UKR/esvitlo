import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize, mergeSchedules, mergeDtekSchedules, scrape} from './schedule.js';
import {scheduleDates, currentSlot, outageHours} from './public/dates.js';
import {scrapeRegional} from './regional-sources.js';
test('DTEK half-hour states and unknown hours',()=>{
 const [day]=normalize({data:{1794520800:{'GPV1.1':{'1':'yes','2':'no','3':'first','4':'second'}}}});
 assert.deepEqual(day.groups['1.1'].slice(0,10),[true,true,false,false,false,true,true,false,null,null]);
 assert.equal(day.groups['1.1'].length,48);assert.equal(Object.keys(day.groups).length,12);
});
test('missing data must not replace last good schedule',()=>{assert.throws(()=>normalize({data:{}}));});
test('regional feed keeps operator queues and carries uncertainty without inventing schedules',async()=>{
 const now=new Date('2026-11-14T12:00:00Z');
 const today=Date.parse('2026-11-14T00:00:00+02:00')/1000;
 const payload={regionId:'kyiv',meta:{schemaVersion:'1.0.0'},mirroredAt:now.toISOString(),fact:{
  emergency:[today],emergencyNote:'У Дарницькому районі введено аварійні відключення.',
  data:{[today]:{'GPV60.1':{1:'mfirst',2:'msecond',3:'no'}},[today-86400]:{'GPV60.1':{1:'no'}}}
 }};
 const fetchImpl=async url=>Response.json(url.endsWith('index.json')?{regions:[{id:'kyiv',hasSchedule:true}]}:payload);
 const result=await scrapeRegional('k',{fetchImpl,now});
 assert.deepEqual(result.days.map(day=>day.date),['2026-11-14']);
 assert.deepEqual(Object.keys(result.days[0].groups),['60.1']);
 assert.deepEqual(result.days[0].groups['60.1'].slice(0,6),[null,true,true,null,false,false]);
 assert.equal(result.emergency.kind,'unplanned');
 assert.deepEqual(result.emergency.areas,['Дарницькому районі']);
 payload.fact.data={};
 assert.deepEqual((await scrapeRegional('k',{fetchImpl,now})).days,[]);
 const stale=async url=>Response.json(url.endsWith('index.json')?{regions:[{id:'kyiv',stale:true}]}:payload);
 assert.equal((await scrapeRegional('k',{fetchImpl:stale,now})).emergency.active,null);
});
import {extractFact} from './schedule.js';
test('extracts fact JSON without consuming following scripts',()=>{
 assert.deepEqual(extractFact('DisconSchedule.fact = {"data":{},"update":"brace } and \\\" quote"}; other = {};'),{data:{},update:'brace } and " quote'});
 assert.equal(extractFact('<html>unavailable</html>'),null);
});

const evening = new Date('2026-11-13T20:15:00Z'); // 22:15 Kyiv
const rawDay = state => ({'GPV1.1':Object.fromEntries(Array.from({length:24},(_,i)=>[i+1,state]))});
const timestamp = date => Date.parse(`${date}T00:00:00+02:00`)/1000;
const twoDays = () => normalize({data:{
 [timestamp('2026-11-14')]:rawDay('no'),
 [timestamp('2026-11-13')]:rawDay('yes')
}});

test('DTEK ignores an older mirror across polls and keeps a new independently published date',()=>{
 const [today,tomorrow]=twoDays();
 const changed={...today,groups:{...today.groups,'1.1':Array(48).fill(false)}};
 const official={days:[changed],sourceUpdatedAt:'13.11.2026 15:59'};
 const mirror={days:[today,tomorrow],sourceUpdatedAt:'13.11.2026 12:49',dataSource:'mirror'};
 const fallback=mergeDtekSchedules(mirror,official,evening);
 assert.equal(fallback.accepted,1);
 assert.deepEqual(fallback.schedule.days,[changed,tomorrow]);
 assert.deepEqual(fallback.schedule.retainedDates,[today.date]);
 assert.equal(fallback.schedule.revisions[tomorrow.date].sourceUpdatedAt,mirror.sourceUpdatedAt);
 assert.equal(fallback.schedule.sourceUpdatedAt,official.sourceUpdatedAt);
 const recovered=mergeDtekSchedules(official,fallback.schedule,evening);
 assert.deepEqual(recovered.schedule.days,fallback.schedule.days);
 assert.equal(recovered.accepted,1);
 assert.deepEqual(mergeDtekSchedules(mirror,recovered.schedule,evening).schedule.days,[changed,tomorrow]);
});

test('DTEK ignores conflicting equal timestamps and permits a genuinely newer version',()=>{
 const [today]=twoDays();
 const changed={...today,groups:{'1.1':Array(48).fill(false)}};
 const saved={days:[today],sourceUpdatedAt:'13.11.2026 15:59'};
 for (const upstream of [
  {sourceUpdatedAt:'2026-11-13T13:59:00Z',dataSource:'mirror'},
  {sourceUpdatedAt:'13.11.2026 15:59'},
  {sourceUpdatedAt:null,dataSource:'mirror'},
  {sourceUpdatedAt:'13.11.2026 12:49'}
 ]) {
  const result=mergeDtekSchedules({days:[changed],...upstream},saved,evening);
  assert.equal(result.accepted,0);
  assert.equal(result.rejected.length,1);
  assert.deepEqual(result.schedule.days,[today]);
 }
 assert.deepEqual(mergeDtekSchedules({days:[changed],sourceUpdatedAt:'13.11.2026 16:00'},saved,evening).schedule.days,[changed]);
});

test('an identical mirror confirms freshness without replacing the official revision',()=>{
 const [today]=twoDays();
 const saved={days:[today],sourceUpdatedAt:'13.11.2026 15:59',retainedDates:[today.date]};
 const mirror={days:[today],sourceUpdatedAt:'2026-11-13T13:59:00Z',dataSource:'mirror'};
 const result=mergeDtekSchedules(mirror,saved,evening);
 assert.equal(result.accepted,1);
 assert.deepEqual(result.rejected,[]);
 assert.deepEqual(result.schedule.retainedDates,[]);
 assert.deepEqual(result.schedule.days,saved.days);
 assert.equal(result.schedule.sourceUpdatedAt,saved.sourceUpdatedAt);
 assert.equal(result.schedule.dataSource,null);
});

test('parses today and tomorrow independently in calendar order',()=>{
 const days=twoDays();
 assert.deepEqual(days.map(d=>d.date),['2026-11-13','2026-11-14']);
 assert.deepEqual(days[0].groups['1.1'],Array(48).fill(true));
 assert.deepEqual(days[1].groups['1.1'],Array(48).fill(false));
 assert.deepEqual(mergeSchedules(days,[],evening),{days,retainedDates:[]});
});

test('tomorrow-only response keeps saved today, without mutating it',()=>{
 const saved=twoDays();const snapshot=JSON.stringify(saved);
 const next=mergeSchedules([saved[1]],saved,evening);
 assert.deepEqual(next.days,saved);
 assert.deepEqual(next.retainedDates,['2026-11-13']);
 assert.equal(JSON.stringify(saved),snapshot);
 assert.deepEqual(mergeSchedules([saved[1]],[],evening).days,[saved[1]]);
});

test('unpublished placeholders and malformed dates do not overwrite saved data',()=>{
 const incoming=normalize({data:{
  [timestamp('2026-11-13')]:rawDay('unknown'),
  [timestamp('2026-11-14')]:rawDay('no'),
  invalid:rawDay('yes'),
  '9999999999999999999':rawDay('yes')
 }});
 assert.deepEqual(incoming.map(d=>d.date),['2026-11-14']);
 assert.deepEqual(mergeSchedules(incoming,twoDays(),evening).retainedDates,['2026-11-13']);
 assert.throws(()=>normalize({data:{[timestamp('2026-11-13')]:rawDay('unknown')}}));
});

test('fresh today replaces saved today and clears retained flag',()=>{
 const saved=twoDays();
 const fresh=normalize({data:{[timestamp('2026-11-13')]:rawDay('no')}});
 const result=mergeSchedules(fresh,saved,evening);
 assert.deepEqual(result.days[0],fresh[0]);
 assert.deepEqual(result.retainedDates,['2026-11-14']);
 assert.deepEqual(mergeSchedules(twoDays(),result.days,evening).retainedDates,[]);
});

test('midnight promotes tomorrow and drops expired dates',()=>{
 const saved=twoDays();const midnight=new Date('2026-11-13T22:00:00Z');
 assert.deepEqual(scheduleDates(new Date('2026-11-13T21:59:59Z')),['2026-11-13','2026-11-14']);
 assert.deepEqual(scheduleDates(midnight),['2026-11-14','2026-11-15']);
 const incoming=normalize({data:{[timestamp('2026-11-15')]:rawDay('yes')}});
 assert.deepEqual(mergeSchedules(incoming,saved,midnight).days.map(d=>d.date),['2026-11-14','2026-11-15']);
 assert.throws(()=>mergeSchedules([saved[0]],saved,midnight));
});

test('Kyiv date window works across year boundaries and both DST transitions',()=>{
 for (const [instant,dates] of [
  ['2026-12-31T22:00:00Z',['2027-01-01','2027-01-02']],
  ['2026-03-28T22:30:00Z',['2026-03-29','2026-03-30']],
  ['2026-10-24T21:30:00Z',['2026-10-25','2026-10-26']]
 ]) assert.deepEqual(scheduleDates(new Date(instant)),dates);
});

test('remaining outage counts only the unelapsed part of the current slot',()=>{
 assert.equal(currentSlot(evening),44.5);
 assert.equal(outageHours(Array(48).fill(false),44.5),1.75);
 assert.equal(outageHours(Array(48).fill(false)),24);
 assert.equal(outageHours([null,true,false],2.5),0.25);
});

test('browser fallback preserves an emergency-only page without fact data',async()=>{
 let closed=false,waited=false;
 const html='<div id="modal-attention"><p>У Одеському районі введені екстрені відключення.</p></div>';
 const browserType={launch:async()=>({
  newPage:async()=>({goto:async()=>{},content:async()=>html,evaluate:async()=>null,waitForFunction:async()=>{waited=true;throw Error('No fact');}}),
  close:async()=>{closed=true;}
 })};
 const result=await scrape('o',{fetchImpl:async()=>new Response('dynamic shell'),browserType});
 assert.equal(result.emergency.active,true);assert.deepEqual(result.days,[]);
 assert.equal(closed,true);assert.equal(waited,false);
});
