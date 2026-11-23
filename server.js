import http from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {scrape,mergeSchedules} from './schedule.js';
import {shutdownsPages} from './vendor/constants.js';
import {schedulesResponse} from './api.js';
import {createTransportSelector} from './transport.js';
import {createTelegram} from './telegram.js';
import {regionNames,isRegion} from './public/regions.js';
import {regionalSources,scrapeRegional} from './regional-sources.js';
import {scheduleDates} from './public/dates.js';
import {createPush} from './push.js';
import {addressRegions,lookupAddress,outageRegions,lookupOutage} from './address-lookup.js';

const defaultRegion=process.env.REGION||'o';
const regions=Object.keys(regionNames);
if(!isRegion(defaultRegion))throw Error('Unknown REGION');
const intervalSeconds=Number(process.env.POLL_INTERVAL_SECONDS||120);
if(!Number.isFinite(intervalSeconds)||intervalSeconds<30||intervalSeconds>3600)throw Error('POLL_INTERVAL_SECONDS must be between 30 and 3600');
const retrySeconds=Number(process.env.VPN_RETRY_SECONDS||60);
if(!Number.isFinite(retrySeconds)||retrySeconds<10)throw Error('VPN_RETRY_SECONDS must be at least 10');
const dir=process.env.DATA_DIR||'./data';
const sendPush=createPush(dir);
await mkdir(dir,{recursive:true});
const empty=()=>({current:null,previous:null,checkedAt:null,lastSuccess:null,error:null,emergency:{active:null,message:null,areas:[],checkedAt:null,stale:true}});
const states=new Map();
const fileFor=region=>dir+'/state-'+region;
let legacy=null;
try{legacy=JSON.parse(await readFile(dir+'/state.json','utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;}
const legacyRegion=legacy?.current?.region??defaultRegion;
for(const region of regions){
 let state={...empty(),...(region===legacyRegion?legacy:null)};
 try{state={...state,...JSON.parse(await readFile(fileFor(region)+'.json','utf8'))};}
 catch(error){if(error.code!=='ENOENT')throw error;}
 if(state.current?.region&&state.current.region!==region)state=empty();
 delete state.pending;
 states.set(region,state);
}
async function save(region){
 const path=fileFor(region);
 await writeFile(path+'.tmp',JSON.stringify(states.get(region)));
 await rename(path+'.tmp',path+'.json');
}
const hash=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
const selectors=new Map(Object.keys(shutdownsPages).map(region=>[region,createTransportSelector({proxyUrl:process.env.DTEK_PROXY_URL,healthUrl:process.env.DTEK_PROXY_HEALTH_URL,retrySeconds})]));
const refreshTimes=new Map();
let telegram;
function snapshot(region=defaultRegion){
 const state=states.get(region);
 const {current,previous,checkedAt,lastSuccess,error,emergency}=state;
 return {current,previous,checkedAt,lastSuccess,error,emergency,region,source:regionalSources[region],dataSource:current?.dataSource??regionalSources[region],telegramEnabled:Boolean(telegram?.enabled),telegramUsername:telegram?.getUsername()||null,
 api:{endpoint:'/api/v1/schedules',refreshIntervalSeconds:intervalSeconds,nextRefreshAt:refreshTimes.get(region)??null}};
}
telegram=await createTelegram({token:process.env.TELEGRAM_BOT_TOKEN,dataDir:dir,defaultRegion,getSnapshot:snapshot,lookupAddress,lookupOutage,publicUrl:process.env.PUBLIC_URL||''});
telegram.start();

async function poll(region){
 const state=states.get(region);
 const selector=selectors.get(region);
 const oldSnapshot=snapshot(region);
 let noticeRead=false;
 try{
  let next;
  if(selector){
   const route=await selector.take();
   try{next=await scrape(region,{proxyUrl:route.proxyUrl});}
   catch{
    selector.failed(route);
    if(route.name==='vpn'){
     try{next=await scrape(region);}catch{/* Try the regional feed below. */}
    }
   }
  }
  const dates=scheduleDates();
  if(!next?.days.some(day=>dates.includes(day.date))){
   const regional=await scrapeRegional(region);
   next={...regional,emergency:next?.emergency.active===true?next.emergency:
    regional.emergency.active===true?regional.emergency:next?.emergency??regional.emergency};
  }
  state.checkedAt=new Date().toISOString();
  noticeRead=next.emergency.active!==null;
  if(next.emergency.active!==null)state.emergency={...next.emergency,checkedAt:state.checkedAt,stale:false};
  else state.emergency={...state.emergency,stale:true};
  if(next.days.length){
   Object.assign(next,mergeSchedules(next.days,state.current?.days));
   delete next.emergency;next.region=region;
   if(hash(next.days)!==hash(state.current?.days)){
    state.previous=state.current;state.current={...next,receivedAt:state.checkedAt};
   }else{
    state.current.sourceUpdatedAt=next.sourceUpdatedAt;state.current.retainedDates=next.retainedDates;state.current.dataSource=next.dataSource;
   }
   state.lastSuccess=state.checkedAt;state.error=null;
  }else state.error='Актуальний плановий графік недоступний. Якщо є збережені дані, показуємо їх.';
 }catch{
  state.checkedAt=new Date().toISOString();
  state.error='Не вдалося отримати графік відключень.';
  if(!noticeRead)state.emergency={...state.emergency,stale:true};
  console.error(`Schedule fetch failed for ${region}; saved schedules preserved.`);
 }
 await save(region);
 const nextSnapshot=snapshot(region);
 await Promise.all([telegram.notify(oldSnapshot,nextSnapshot),
  sendPush(oldSnapshot,nextSnapshot,regionNames[region]).catch(()=>console.warn('FCM publication failed.'))]);
}

const files=Object.assign(Object.create(null),{'/':'index.html','/style.css':'style.css','/app.js':'app.js','/dates.js':'dates.js','/regions.js':'regions.js'});
files['/manifest.webmanifest']='manifest.webmanifest';
files['/privacy.html']='privacy.html';
files['/sw.js']='sw.js';
for(const size of [192,512])files[`/brand/app-${size}.png`]=`brand/app-${size}.png`;
for(const asset of ['favicon.svg','favicon.png','logo.svg','avatar.png','logo-transparent.png'])files[`/brand/${asset}`]=`brand/${asset}`;
const mimeTypes={js:'text/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',html:'text/html; charset=utf-8',webmanifest:'application/manifest+json'};
const assets=new Map(await Promise.all(Object.entries(files).map(async ([path,file])=>[path,{
 type:mimeTypes[file.split('.').at(-1)],body:await readFile(new URL(`./public/${file}`,import.meta.url))
}])));
const apiCaches=new Map();
function clientAddress(req){
 const forwarded=req.headers['x-dtek-client-ip'];
 return process.env.TRUST_CADDY==='1'&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:req.socket.remoteAddress;
}
function rateLimiter(perClient, total){
 const clients=new Map();
 let minute=-1, requests=0;
 return req=>{
  const window=Math.floor(Date.now()/60000);
  if(window!==minute){minute=window;clients.clear();requests=0;}
  const address=clientAddress(req);
  const count=clients.get(address)??0;
  if(count>=perClient||requests>=total)return false;
  clients.set(address,count+1);requests++;
  return true;
 };
}
const allowApiRequest=rateLimiter(120,2400);
const allowAddressRequest=rateLimiter(10,60);
const addressFields=['region','city','street','house'];
let runningAddressRequests=0;
async function handleAddress(req,res,url,outage){
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store',
  'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After'};
 const respond=(code,result,extra)=>{res.writeHead(code,{...headers,...extra});res.end(JSON.stringify(result));};
 if(req.method==='OPTIONS'&&!url.search&&!req.headers['transfer-encoding']&&
    (!req.headers['content-length']||req.headers['content-length']==='0')){
  res.writeHead(204,{...headers,'Access-Control-Allow-Methods':'POST',
   'Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});
  res.end();return;
 }
 const reject=(code,status,extra)=>respond(code,{status,groups:[]},{Connection:'close',...extra});
 if(req.method!=='POST'){reject(405,'method_not_allowed',{Allow:'POST, OPTIONS'});return;}
 if(!allowAddressRequest(req)){
  reject(429,'rate_limited',{'Retry-After':String(60-Math.floor(Date.now()/1000)%60)});return;
 }
 if(req.headers['transfer-encoding']||url.search||
    !/^[1-9]\d{0,3}$/.test(req.headers['content-length']??'')){
  reject(400,'invalid');return;
 }
 if(Number(req.headers['content-length'])>2048){reject(413,'too_large');return;}
 if(req.headers['content-encoding']||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){
  reject(415,'unsupported_media_type');return;
 }
 let input;
 try{
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==addressFields.length||
     addressFields.some(key=>typeof input[key]!=='string'||!input[key].trim()||
      input[key].length>100||/[\u0000-\u001f\u007f]/u.test(input[key]))||!isRegion(input.region))throw Error('Invalid input');
 }catch{reject(400,'invalid');return;}
 if(!(outage?outageRegions:addressRegions).includes(input.region)){respond(200,{status:'unsupported',groups:[]});return;}
 if(runningAddressRequests>=3){reject(429,'rate_limited',{'Retry-After':'5'});return;}
 runningAddressRequests++;
 try{
  const result=await (outage?lookupOutage:lookupAddress)(input.region,input);
  respond(result.status==='invalid'?400:200,result);
 }finally{runningAddressRequests--;}
}
const server=http.createServer({headersTimeout:10000,requestTimeout:15000,keepAliveTimeout:5000,maxHeaderSize:8192,connectionsCheckingInterval:1000},async (req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 try{
  if(req.url.length>2048){res.writeHead(414);res.end();return;}
  const url=new URL(req.url,'http://localhost');const path=url.pathname;
  const publicApi=path==='/api/v1/schedules'||path==='/api/v1/regions';
  if(publicApi)res.setHeader('Access-Control-Allow-Origin','*');
  if((publicApi||path==='/api/schedule')&&!allowApiRequest(req)){
   res.writeHead(429,{'Retry-After':String(60-Math.floor(Date.now()/1000)%60),'Cache-Control':'no-store'});res.end();return;
  }
  if(path==='/api/v1/address-queue'||path==='/api/v1/address-outage'){
   await handleAddress(req,res,url,path.endsWith('-outage'));return;
  }
  if(req.headers['transfer-encoding']||(req.headers['content-length']&&req.headers['content-length']!=='0')){
   res.writeHead(400,{'Connection':'close'});res.end();return;
  }
  if(req.method==='OPTIONS'&&publicApi){
   res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'If-None-Match'});res.end();return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
  if(path==='/api/v1/regions'){
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300'});
   res.end(req.method==='HEAD'?'':JSON.stringify({defaultRegion,regions:regions.map(code=>({code,name:regionNames[code],source:regionalSources[code],addressLookup:addressRegions.includes(code),outageLookup:outageRegions.includes(code)}))}));return;
  }
  if(path==='/api/v1/schedules'||path==='/api/schedule'){
   const codes=url.searchParams.getAll('region');
   const region=codes[0]??defaultRegion;
   if(codes.length>1||!isRegion(region)){
    res.writeHead(400,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:'Invalid region; see /api/v1/regions'}));return;
   }
   const selected=snapshot(region);
   if(path==='/api/v1/schedules'){
    const generation=JSON.stringify([selected.checkedAt,selected.api.nextRefreshAt]);
    let entry=apiCaches.get(region);
    if(entry?.generation!==generation){entry={generation,cache:new Map()};apiCaches.set(region,entry);}
    const result=schedulesResponse(url,selected,{ifNoneMatch:req.headers['if-none-match'],cache:entry.cache});
    res.writeHead(result.status,{...result.headers,'Access-Control-Expose-Headers':'ETag, Retry-After'});
    res.end(req.method==='HEAD'?'':result.body);return;
   }
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
   res.end(req.method==='HEAD'?'':JSON.stringify(selected));return;
  }
  if(path==='/health'){res.writeHead(200);res.end(req.method==='HEAD'?'':'ok');return;}
  const asset=assets.get(path);
  if(!asset){res.writeHead(404);res.end();return;}
  if(path==='/sw.js')res.setHeader('Cache-Control','no-cache');
  res.writeHead(200,{'Content-Type':asset.type,'Content-Length':asset.body.length});
  res.end(req.method==='HEAD'?'':asset.body);
 }catch{if(!res.headersSent)res.writeHead(500);res.end('Server error');}
});
server.on('checkContinue',(_req,res)=>{res.writeHead(417,{'Connection':'close'});res.end();});
server.listen(Number(process.env.PORT||3000),'0.0.0.0');
let stopping=false;
const timers=new Map(), inFlight=new Set();
function schedulePoll(region,delay){
 if(stopping)return;
 refreshTimes.set(region,new Date(Date.now()+delay).toISOString());
 timers.set(region,setTimeout(()=>{
  const started=Date.now();
  refreshTimes.set(region,new Date(started+intervalSeconds*1000).toISOString());
  const task=poll(region).catch(()=>console.error('Polling failed for '+region)).finally(()=>{
   inFlight.delete(task);
   schedulePoll(region,Math.max(1000,intervalSeconds*1000-(Date.now()-started)));
  });
  inFlight.add(task);
 },delay));
}
[defaultRegion,...regions.filter(region=>region!==defaultRegion)].forEach((region,i)=>schedulePoll(region,i*3000));
async function shutdown(){
 if(stopping)return;
 stopping=true;
 for(const timer of timers.values())clearTimeout(timer);
 server.close();
 await Promise.allSettled(inFlight);
 await telegram.stop();
}
process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
