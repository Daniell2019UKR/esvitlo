import { PowerState, shutdownsPages } from './vendor/constants.js';
import { scheduleDates } from './public/dates.js';
import {extractEmergency} from './emergency.js';
import {standardGroups,isGroup,sortGroups} from './public/regions.js';
export const groups=standardGroups;
export function normalize(raw,{onlyPublished=false,includeGroup=()=>true}={}) {
  const days = Object.entries(raw?.data ?? {}).filter(([timestamp, data]) =>
    /^\d+$/.test(timestamp) && Number.isFinite(new Date(Number(timestamp)*1000).getTime()) && data && typeof data === 'object'
  ).sort(([a],[b])=>Number(a)-Number(b)).map(([timestamp, data])=>({
    date:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv'}).format(new Date(Number(timestamp)*1000)),
    groups:Object.fromEntries(sortGroups([
      ...(onlyPublished?[]:groups),
      ...Object.keys(data).filter(key=>key.startsWith('GPV')&&isGroup(key.slice(3))).map(key=>key.slice(3))
    ]).filter(includeGroup).map(group=>[group,Array.from({length:24},(_,hour)=>{
      const state=data[`GPV${group}`]?.[hour+1];
      switch(state){case PowerState.ON:return [true,true];case PowerState.OFF:return [false,false];case PowerState.HALF_ON:return [true,false];case PowerState.HALF_OFF:return [false,true];case 'mfirst':return [null,true];case 'msecond':return [true,null];default:return [null,null];}
    }).flat()]))
  })).filter(d=>Object.values(d.groups).some(s=>s.some(v=>v!==null)));
  if(!days.length) throw Error('Джерело не опублікувало розпізнаваний графік');
  return days;
}

export function mergeSchedules(incoming, saved = [], now = new Date()) {
  const dates = scheduleDates(now);
  const fresh = incoming.filter(day => dates.includes(day.date));
  if (!fresh.length) throw Error('Джерело не опублікувало графік на сьогодні або завтра');
  const retainedDates = [];
  const days = dates.flatMap(date => {
    const day = fresh.find(day => day.date === date);
    if (day) return [day];
    const cached = saved.find(day => day.date === date);
    if (!cached) return [];
    retainedDates.push(date);
    return [cached];
  });
  return {days, retainedDates};
}

function revisionTime(value) {
  if (typeof value !== 'string') return null;
  const local = /^(\d{2})\.(\d{2})\.(\d{4})[ ,]+(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  const iso = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Date.parse(value);
  const civil = local ? [local[3],local[2],local[1],local[4],local[5]].join('') : null;
  if (civil) return Number(civil);
  if (!Number.isFinite(iso)) return null;
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',
    day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(iso);
  const fields = Object.fromEntries(parts.map(({type,value})=>[type,value]));
  return Number(fields.year+fields.month+fields.day+fields.hour+fields.minute);
}

const revisionOf = schedule => ({
  sourceUpdatedAt:schedule.sourceUpdatedAt??null,
  dataSource:schedule.dataSource??null
});

export function mergeDtekSchedules(incoming, saved, now = new Date()) {
  const savedDays = saved?.days??[];
  const dates = scheduleDates(now);
  const revisions = {};
  const rejected = [];
  const incomingRevision = revisionOf(incoming);
  const incomingTime = revisionTime(incomingRevision.sourceUpdatedAt);
  const accepted = incoming.days.filter(day=>{
    if (!dates.includes(day.date)) return false;
    const priorDay = savedDays.find(previous=>previous.date===day.date);
    if (!priorDay) return true;
    const prior = saved.revisions?.[day.date]??revisionOf(saved);
    const priorTime = revisionTime(prior.sourceUpdatedAt);
    const different = JSON.stringify(priorDay.groups)!==JSON.stringify(day.groups);
    const older = priorTime!==null&&(incomingTime===null||incomingTime<priorTime);
    const weaker = prior.dataSource===null&&incomingRevision.dataSource!==null&&
      (incomingTime===null||priorTime===null||incomingTime===priorTime);
    if (weaker&&priorTime!==null&&incomingTime===priorTime&&!different) {
      revisions[day.date]=prior;
      return true;
    }
    const sameRevision = priorTime!==null&&incomingTime===priorTime&&
      (prior.dataSource!==null)===(incomingRevision.dataSource!==null);
    if (!older&&!weaker&&!(different&&sameRevision)) return true;
    rejected.push({date:day.date,incoming:incomingRevision,kept:prior});
    return false;
  });
  const {days,retainedDates} = accepted.length ? mergeSchedules(accepted,savedDays,now) : {
    days:savedDays.filter(day=>dates.includes(day.date)),
    retainedDates:savedDays.filter(day=>dates.includes(day.date)).map(day=>day.date)
  };
  for (const day of days) revisions[day.date] ??= retainedDates.includes(day.date) ?
    saved.revisions?.[day.date]??revisionOf(saved) : incomingRevision;
  const latest = Object.values(revisions).sort((a,b)=>(revisionTime(b.sourceUpdatedAt)??0)-
    (revisionTime(a.sourceUpdatedAt)??0)||Number(a.dataSource!==null)-Number(b.dataSource!==null))[0]??incomingRevision;
  return {schedule:{days,retainedDates,revisions,...latest},rejected,accepted:accepted.length};
}
export function extractFact(html) {
  const start=html.search(/(?:DisconSchedule\.)?fact\s*=\s*\{/);
  if(start<0)return null;
  const begin=html.indexOf('{',start);let depth=0,quoted=false,escaped=false;
  for(let i=begin;i<html.length;i++){
    const c=html[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return JSON.parse(html.slice(begin,i+1));
  }
  return null;
}
export async function scrape(region, {proxyUrl, fetchImpl=fetch, browserType} = {}) {
  const dispatcher=proxyUrl?new (await import('undici')).ProxyAgent(proxyUrl):null;
  const headers={'Cache-Control':'no-cache','Pragma':'no-cache'};
  const result=(raw,html)=>{
    const emergency=extractEmergency(html);
    let days=[];
    try {days=normalize(raw,{onlyPublished:region==='k',includeGroup:group=>region!=='k'||group.endsWith('.1')});}catch(error){if(emergency.active!==true)throw error;}
    return {days,sourceUpdatedAt:raw?.update??null,emergency};
  };
  try {
  // The same fact JSON used by upstream; HTTP first avoids a browser for static pages.
  try {
    const response=await fetchImpl(shutdownsPages[region],{headers,signal:AbortSignal.timeout(30000),...(dispatcher?{dispatcher}:{})});
    if(response.ok){const html=await response.text();const raw=extractFact(html);if(raw||extractEmergency(html).active===true)return result(raw,html);}
  }catch{/* Dynamic pages fall back to upstream's Playwright approach. */}

  const chromium=browserType??(await import('playwright')).chromium;
  const browser=await chromium.launch({headless:true,...(proxyUrl?{proxy:{server:proxyUrl}}:{}),...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try {
    const page=await browser.newPage({extraHTTPHeaders:headers});
    await page.goto(shutdownsPages[region],{waitUntil:'load',timeout:45000});
    const initialHtml=await page.content();
    if(extractEmergency(initialHtml).active===true){
      const raw=await page.evaluate(()=>typeof DisconSchedule!=='undefined'?DisconSchedule.fact:null);
      return result(raw,initialHtml);
    }
    try {
      await page.waitForFunction(()=>(typeof DisconSchedule!=='undefined'&&DisconSchedule.fact?.data)||document.querySelector('#modal-attention .m-attention__text')?.textContent?.trim(),null,{timeout:15000});
    }catch(error){if(extractEmergency(await page.content()).active!==true)throw error;}
    const raw=await page.evaluate(()=>typeof DisconSchedule!=='undefined'?DisconSchedule.fact:null);
    return result(raw,await page.content());
  } finally {await browser.close();}
  } finally {if(dispatcher)await dispatcher.close();}
}
