const source = 'https://cek.dp.ua/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html';
const mykolaivSource = 'https://off.energy.mk.ua/';
const odesaSource = 'https://www.dtek-oem.com.ua/ua/shutdowns';
const khmelnytskyiSource = 'https://hoe.com.ua/shutdown/new';
export const addressRegions = ['o','cek','mykolaiv'];
const powerOn = {
 lviv: {source:'https://poweron.loe.lviv.ua/',api:'https://power-api.loe.lviv.ua/api/'},
 zhytomyr: {source:'https://ztoe-poweron.inneti.net/',api:'https://api-ztoe-poweron.inneti.net/api/'}
};
export const outageRegions = ['o','khmelnytskyi',...Object.keys(powerOn)];

export function odesaOutage(house) {
 if (!house || house.cek || typeof house.type !== 'string') return {status:'unavailable'};
 if (house.type === '1') return {status:'no_emergency'};
 if (house.type === '' && house.sub_type === '' && house.start_date === '' && house.end_date === '')
  return {status:'no_emergency'};
 if (house.type !== '2') return {status:'unavailable'};
 const clean = value => typeof value==='string'?value.replace(/<[^>]*>/gu,'').replace(/\s+/gu,' ').trim().slice(0,200):'';
 const reason=clean(house.sub_type);
 if (/^(?:стабілізаційн|планов)/iu.test(reason)) return {status:'no_emergency'};
 if (!/^(?:аварій|екстрен)/iu.test(reason)) return {status:'unavailable'};
 return {status:'active',reason,startedAt:clean(house.start_date),
  estimatedRestoration:clean(house.end_date)};
}

const normal = value => value.normalize('NFC').toLocaleLowerCase('uk')
 .replace(/[’ʼ`]/gu,"'").replace(/\s+/gu,' ').trim();
const city = value => normal(value).replace(/^(?:м\.|с\.|смт\.?|с-ще)\s*/u,'');
const street = value => normal(value).replace(/^(?:вул\.|пров\.|просп\.|пл\.)\s*/u,'');

export function resolveCek(locations, input) {
 const groups = new Set();
 for (const [name, streets] of Object.entries(locations)) {
  if (city(name) !== city(input.city)) continue;
  for (const [name, houses] of Object.entries(streets)) {
   if (street(name) !== street(input.street)) continue;
   for (const [number, label] of Object.entries(houses)) {
    if (normal(number) !== normal(input.house)) continue;
    for (const group of String(label).matchAll(/(?<![\d.])([1-6]\.[12])(?![\d.])/gu)) groups.add(group[1]);
   }
  }
 }
 return [...groups].sort();
}

let cached, pending, mykolaivCities, cityRequest, odesa, odesaRequest;

async function odesaData(session, method, fields = {}) {
 const body = new URLSearchParams({method});
 Object.entries(fields).forEach(([name,value],index)=>{
  body.set(`data[${index}][name]`,name);
  body.set(`data[${index}][value]`,value);
 });
 const response = await fetch(new URL('/ua/ajax',odesaSource),{method:'POST',body,redirect:'error',
  headers:{'X-Requested-With':'XMLHttpRequest','X-CSRF-Token':session.csrf,cookie:session.cookies,referer:odesaSource},
  signal:AbortSignal.timeout(5000)});
 if (!response.ok) throw Error('Address source unavailable');
 const data = await response.json();
 if (data.result !== true) throw Error('Address source rejected the request');
 return data;
}

async function resolveOdesa(input, outage=false) {
 if (!odesa || Date.now() >= odesa.expires) {
  odesaRequest ??= (async () => {
   const response = await fetch(odesaSource,{redirect:'error',signal:AbortSignal.timeout(5000)});
   if (!response.ok) throw Error('Address source unavailable');
   const csrf=(await response.text()).match(/<meta name="csrf-token" content="([^"]+)"/u)?.[1];
   const cookies=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
   if (!csrf||!cookies) throw Error('Address session unavailable');
   const session={csrf,cookies};
   const {streets}=await odesaData(session,'getStreets');
   if(!streets||typeof streets!=='object'||Array.isArray(streets))throw Error('Invalid address catalog');
   odesa={...session,streets,expires:Date.now()+900000};
  })().finally(()=>{odesaRequest=null;});
  await odesaRequest;
 }
 const groups=new Set();
 const matches=[];
 for(const [town,streets] of Object.entries(odesa.streets)){
  if(city(town)!==city(input.city)||!Array.isArray(streets))continue;
  for(const road of streets){
   if(typeof road!=='string'||street(road)!==street(input.street))continue;
   const {data}=await odesaData(odesa,'getHomeNum',{city:town,street:road});
   for(const [number,house] of Object.entries(data??{})){
    if(normal(number)!==normal(input.house))continue;
    if(outage){matches.push(house);continue;}
    for(const value of Array.isArray(house?.sub_type_reason)?house.sub_type_reason:[]){
     const match=/^GPV([1-6]\.[12])$/.exec(value);
     if(match)groups.add(match[1]);
    }
   }
  }
 }
 if(outage){
  if(matches.length!==1)return {status:matches.length?'ambiguous':'not_found'};
  return odesaOutage(matches[0]);
 }
 return [...groups].sort();
}

export function khmelnytskyiOutage(html) {
 if (html.includes('За вказаною адресою відсутнє зареєстроване відключення')) return {status:'no_emergency'};
 if (!/<table[^>]+class="[^"]*\btable-shutdowns\b/u.test(html)||!html.includes('Вид робіт')) return {status:'unavailable'};
 const rows=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(([,row])=>
  [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map(([,cell])=>cell.replace(/<[^>]*>/gu,'').trim()));
 const local=rows.filter(row=>row[0]==='Аварійні'&&row[1]==='Аварійне'&&row.length===6);
 if (local.length>1) return {status:'ambiguous'};
 if (local.length===1) return {status:'active',reason:'Аварійні роботи',
  startedAt:local[0][4],estimatedRestoration:local[0][5]==='-'?'':local[0][5]};
 return rows.some(row=>row[0]&&!/^(?:Планові|Графік погодинних відключень)$/u.test(row[0])) ?
  {status:'unavailable'}:{status:'no_emergency'};
}

async function resolveKhmelnytskyi(input) {
 const read=async(path,body)=>{
  const response=await fetch(new URL(path,khmelnytskyiSource),{...(body?{method:'POST',body}:{}),redirect:'error',
   headers:{'X-Requested-With':'XMLHttpRequest',referer:khmelnytskyiSource},signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw Error('Address source unavailable');
  return response;
 };
 const matches=(items,value,normalize)=>items.filter(item=>Number.isSafeInteger(item.id)&&typeof item.text==='string'&&
  normalize(item.text)===normalize(value));
 const settlements=await (await read('/settlements?term='+encodeURIComponent(city(input.city).split(' (')[0]))).json();
 const exact=matches(settlements,input.city,city);
 const towns=exact.length?exact:matches(settlements,input.city,value=>city(value).split(' (')[0]);
 if(towns.length!==1)return {status:towns.length?'ambiguous':'not_found'};
 const roads=matches(await (await read('/streets/'+towns[0].id+'?term='+encodeURIComponent(street(input.street)))).json(),input.street,street);
 if(roads.length!==1)return {status:roads.length?'ambiguous':'not_found'};
 const houses=await (await read('/houses/'+roads[0].id)).json();
 const matching=houses.filter(value=>typeof value==='string'&&normal(value)===normal(input.house));
 if(matching.length!==1)return {status:matching.length?'ambiguous':'not_found'};
 return khmelnytskyiOutage(await (await read('/shutdown-events',new URLSearchParams({
  streetId:roads[0].id,house:matching[0]}))).text());
}

const powerOnCities=new Map();
const houseKey=value=>normal(value).replace(/(?<=\d)[\s-]+(?=\p{L}$)/u,'');
const operatorTime=new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',dateStyle:'short',timeStyle:'short'});
const displayTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?operatorTime.format(new Date(value)):'';

export function powerOnOutage(rows,house) {
 let uncertain=false;
 const active=new Map();
 for(const row of rows){
  if(row?.typeOff!==1||row.switchSubReason!==0)continue;
  if(typeof row.buildingNames!=='string'||!row.buildingNames){uncertain=true;continue;}
  const names=row.buildingNames.split(',').map(houseKey);
  if(names.includes(houseKey(house)))active.set(JSON.stringify([row.dateEvent,row.datePlanIn]),row);
  else if(names.some(name=>!/^\d+[\p{L}]?(?:\/\d+[\p{L}]?)?$/u.test(name)))uncertain=true;
 }
 if(active.size>1)return {status:'ambiguous'};
 if(active.size===1){
  const [row]=active.values();
  return {status:'active',reason:'Аварійне відключення',
   startedAt:displayTime(row.dateEvent),estimatedRestoration:displayTime(row.datePlanIn)};
 }
 return {status:uncertain?'unavailable':'no_emergency'};
}

async function resolvePowerOn(region,input) {
 const {api,source}=powerOn[region];
 const read=async (path,query)=>{
  const url=new URL(path,api);url.search=new URLSearchParams({pagination:'false',...query});
  const r=await fetch(url,{redirect:'error',headers:{accept:'application/json',referer:source},signal:AbortSignal.timeout(3000)});
  if(!r.ok)throw Error('Address source unavailable');
  const json=await r.json(), rows=Array.isArray(json)?json:json['hydra:member'];
  if(!Array.isArray(rows)||(!Array.isArray(json)&&json['hydra:totalItems']!==rows.length))throw Error('Invalid address response');
  return rows;
 };
 let catalog=powerOnCities.get(region);
 if(!catalog||catalog.expires<=Date.now()){
  catalog={expires:Date.now()+3600000,rows:read('pw_cities').catch(error=>{powerOnCities.delete(region);throw error;})};
  powerOnCities.set(region,catalog);
 }
 const matches=(rows,value,normalize)=>rows.filter(item=>Number.isSafeInteger(item.id)&&typeof item.name==='string'&&
  normalize(item.name)===normalize(value));
 const [town,district]=input.city.split(/\s*\(/u,2);
 const towns=matches(await catalog.rows,town,city).filter(item=>
  !district||normal(item.otg?.name??'')===normal(district.replace(/\)\s*$/u,'')));
 if(towns.length!==1)return {status:towns.length?'ambiguous':'not_found'};
 const cityId=towns[0].id;
 const roads=matches(await read('pw_streets',{'city.id':cityId}),input.street,street);
 if(roads.length!==1)return {status:roads.length?'ambiguous':'not_found'};
 const streetId=roads[0].id;
 const rows=await read('pw_accidents',{'city.id':cityId,'street.id':streetId});
 if(rows.some(row=>!Number.isInteger(row.typeOff)||row.street?.id!==streetId||row.city?.id!==cityId))
  return {status:'unavailable'};
 return powerOnOutage(rows,input.house);
}

export async function lookupOutage(region,input) {
 if(!outageRegions.includes(region))return {status:'unsupported'};
 if(['city','street','house'].some(key=>typeof input[key]!=='string'||!input[key].trim()||
  input[key].length>100||/[\u0000-\u001f\u007f]/u.test(input[key])))return {status:'invalid'};
 const source=region==='o'?odesaSource:powerOn[region]?.source??khmelnytskyiSource;
 try{
  const result=region==='o'?await resolveOdesa(input,true):region==='khmelnytskyi'?
   await resolveKhmelnytskyi(input):await resolvePowerOn(region,input);
  return {...result,source};
 }
 catch{return {status:'unavailable',source};}
}

async function mykolaivData(path) {
 const response = await fetch(mykolaivSource+'api/addr/'+path,{redirect:'error',signal:AbortSignal.timeout(4000)});
 if (!response.ok) throw Error('Address source unavailable');
 const rows = await response.json();
 if (!Array.isArray(rows)) throw Error('Invalid address source response');
 return rows;
}

async function resolveMykolaiv(input) {
 if (!mykolaivCities || Date.now() >= mykolaivCities.expires) {
  cityRequest ??= (async () => {
   const branches = await mykolaivData('filii');
   const cities=[];
   for(let index=0;index<branches.length;index+=6) {
    const ids=branches.slice(index,index+6).map(branch=>branch.idfilial).filter(Number.isSafeInteger);
    cities.push(...(await Promise.all(ids.map(id=>mykolaivData(`filii/${id}/ns`)))).flat());
   }
   mykolaivCities={cities,expires:Date.now()+3600000};
  })().finally(()=>{cityRequest=null;});
  await cityRequest;
 }
 const ids = (rows, name, id, normalize, value) =>
  [...new Set(rows.filter(row=>typeof row[name]==='string'&&normalize(row[name])===normalize(value))
   .map(row=>row[id]).filter(Number.isSafeInteger))];
 const settlements=ids(mykolaivCities.cities,'naznaspunkt','idnaspunkt',city,input.city);
 const streets=ids((await Promise.all(settlements.map(id=>mykolaivData(`ns/${id}/street`)))).flat(),
  'nazstreet','idstreet',street,input.street);
 const houses=ids((await Promise.all(streets.map(id=>mykolaivData(`street/${id}/dom`)))).flat(),
  'nazdom','iddom',normal,input.house);
 const queues=(await Promise.all(houses.map(id=>mykolaivData(`dom/${id}/outage-queue`)))).flat();
 return [...new Set(queues.filter(row=>row.outageType?.name==='ГПВ'&&/^[1-6]\.[12]$/.test(row.outage?.name))
  .map(row=>row.outage.name))].sort();
}

export async function lookupAddress(region, input) {
 if (!addressRegions.includes(region)) return {status:'unsupported',groups:[]};
 if (['city','street','house'].some(key => typeof input[key] !== 'string' ||
     input[key].trim().length === 0 || input[key].length > 100)) return {status:'invalid',groups:[]};
 const provider = region==='cek'?source:region==='o'?odesaSource:mykolaivSource;
 try {
  if(region!=='cek'){
   const groups=await (region==='o'?resolveOdesa(input):resolveMykolaiv(input));
   return {status:groups.length?'ok':'not_found',groups,source:provider};
  }
  if (!cached || Date.now() >= cached.expires) {
   pending ??= (async () => {
    const response = await fetch(source,{redirect:'error',signal:AbortSignal.timeout(7000)});
    if (!response.ok) throw Error('Address source unavailable');
    const match = (await response.text()).match(/\bconst\s+locations\s*=\s*(\{[^\r\n]+\});/u);
    if (!match) throw Error('Address catalog not found');
    cached = {locations:JSON.parse(match[1]),expires:Date.now()+3600000};
   })().finally(()=>{pending=null;});
   await pending;
  }
  const groups = resolveCek(cached.locations,input);
  return {status:groups.length?'ok':'not_found',groups,source};
 } catch {
  return {status:'unavailable',groups:[],source:provider};
 }
}
