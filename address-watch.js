import {createHash} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {lookupOutage,outageRegions} from './address-lookup.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const id=/^[a-zA-Z0-9-]{1,64}$/u;
const text=value=>typeof value==='string'&&value.trim()&&value.length<=100&&!/[\u0000-\u001f\u007f]/u.test(value);
const expiresAfter=30*86400000;
const checkEvery=5*60000;

export function addressChange(previous,result) {
 if(result?.status==='no_emergency'){
  if(!previous.active)return {clear:0};
  if(!previous.clear)return {...previous,clear:1};
  return {clear:0,body:'Оператор більше не повідомляє про аварію за цією адресою.'};
 }
 if(result?.status!=='active')return {...previous,clear:0};
 const key=hash(JSON.stringify([result.reason,result.startedAt,result.estimatedRestoration]));
 if(key===previous.active)return {active:key,clear:0};
 return {active:key,clear:0,body:[previous.active?'Оператор оновив дані про аварію.':'Аварійне відключення за адресою.',
  result.reason,result.startedAt&&'Початок: '+result.startedAt,
  result.estimatedRestoration&&'Орієнтовне відновлення: '+result.estimatedRestoration].filter(Boolean).join('\n')};
}

export async function createAddressWatch({dir,send,audit,lookup=lookupOutage,now=Date.now}) {
 const path=join(dir,'address-watch.json');
 const devices=new Map(await readFile(path,'utf8').then(JSON.parse).catch(error=>{
  if(error.code==='ENOENT')return [];
  throw error;
 }));
 const save=async()=>{
  await writeFile(path+'.tmp',JSON.stringify([...devices]),{mode:0o600});
  await rename(path+'.tmp',path);
 };
 let serial=Promise.resolve();
 const locked=operation=>{
  const job=serial.then(operation);serial=job.catch(()=>{});return job;
 };
 const prune=()=>{
  let changed=false;
  for(const [key,device] of devices)if(device.expiresAt<=now()){devices.delete(key);changed=true;}
  return changed;
 };
 async function update(secret,input) {
  if(!send)return 503;
  if(typeof secret!=='string'||!/^Bearer [a-f0-9]{64}$/u.test(secret))return 401;
  const places=input?.places;
  if(!Array.isArray(places)||places.length>12||places.some(place=>!place||typeof place.id!=='string'||!id.test(place.id)||
   !outageRegions.includes(place.region)||!['city','street','house'].every(key=>text(place[key])))||
   new Set(places.map(place=>place.id)).size!==places.length)return 400;
  if(places.length&&(typeof input.token!=='string'||!/^[\w:-]{30,4096}$/u.test(input.token)))return 400;
  return locked(async()=>{
   const pruned=prune();
   const key=hash(secret.slice(7));
   const previous=devices.get(key);
   if(!places.length){
    if(devices.delete(key)||pruned)await save();
    return 204;
   }
   if(!previous&&devices.size>=100)return 503;
   const total=[...devices.values()].reduce((sum,device)=>sum+device.watches.length,0);
   if(total-(previous?.watches.length??0)+places.length>60)return 503;
   const watches=places.map(({id,region,city,street,house})=>{
    const address={region,city:city.trim(),street:street.trim(),house:house.trim()};
    const current=previous?.watches.find(watch=>watch.id===id&&JSON.stringify(watch.address)===JSON.stringify(address));
    return current??{id,address,next:0,state:{}};
   });
   devices.set(key,{token:input.token,watches,expiresAt:now()+expiresAfter});
   await save();
   return 204;
  });
 }
 let working=false;
 async function tick(){
  if(!send||working)return;
  working=true;
  try{
   const due=await locked(async()=>{
    if(prune())await save();
    return [...devices].flatMap(([key,device])=>device.watches.filter(watch=>watch.next<=now()).map(watch=>({key,watch})))
     .sort((a,b)=>a.watch.next-b.watch.next).slice(0,3);
   });
   const lookups=new Map();
   await Promise.all(due.map(async({key,watch})=>{
    const addressKey=JSON.stringify(watch.address);
    if(!lookups.has(addressKey))lookups.set(addressKey,lookup(watch.address.region,watch.address));
    const result=await lookups.get(addressKey);
    await locked(async()=>{
     const device=devices.get(key);
     if(!device?.watches.includes(watch))return;
     watch.next=now()+checkEvery;
     const {body,...state}=addressChange(watch.state,result);
     if(body)try {
      const event=hash(JSON.stringify([watch.id,watch.state.active??null,state.active??null]));
      await send(device.token,{type:'address-outage',id:watch.id,body,event});
     }catch(error){
      if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(error.code))devices.delete(key);
      audit?.('address_notification',{status:'failed',region:watch.address.region});
      return;
     }
     if(body)audit?.('address_notification',{status:'accepted',region:watch.address.region});
     watch.state=state;
    });
   }));
   if(due.length)await locked(save);
  }finally{working=false;}
 }
 return {update,tick};
}
