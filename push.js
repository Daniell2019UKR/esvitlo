import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getMessaging} from 'firebase-admin/messaging';
import {noticeType} from './notification-types.js';
import {scheduleDates} from './public/dates.js';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const normalized=text=>(text??'').normalize('NFC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/gu,'').replace(/\s+/gu,' ').trim();
const displayDate=date=>date.split('-').reverse().join('-');

export function pushEvents(before,after,now=new Date()){
 const region=after.region;
 const previous=before.emergency;
 const notice=after.emergency;
 const events=[];
 if(!notice?.stale&&(notice?.active===true||notice?.active===false&&previous?.active===true)){
  const message=normalized(notice.message);
  if(notice.active!==previous?.active||notice.active&&(notice.kind!==previous.kind||message!==normalized(previous.message))){
   events.push({topic:`notice-${region}`,region,type:notice.active?noticeType(notice.kind):'clearance',body:notice.active?message||'Оператор повідомив про відключення.':'Оператор зняв попередження про відключення.'});
  }
 }
 const dates=scheduleDates(now);
 if(after.error)return events;
 for(const day of after.current?.days??[]){
  if(!dates.includes(day.date)||after.current.retainedDates?.includes(day.date))continue;
  const old=before.current?.days?.find(candidate=>candidate.date===day.date);
  if(!old&&(!before.current||day.date!==dates[1]))continue;
  for(const [group,slots] of Object.entries(day.groups)){
   if(!slots.some(value=>typeof value==='boolean')||JSON.stringify(old?.groups[group])===JSON.stringify(slots))continue;
   events.push({topic:`schedule-${region}-${group}`,region,group,type:old?'schedule':'publication',
    body:`${old?'Оновлено':'Додано'} графік на ${displayDate(day.date)} · черга ${group}`});
  }
 }
 return events;
}

const releaseTag=/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/u;
function watchAndroidReleases(messaging,dir){
 const state=join(dir,'android-release-push.txt');
 async function check(){
  try {
   const response=await fetch('https://api.github.com/repos/Daniell2019UKR/esvitlo-android/releases/latest',{
    headers:{Accept:'application/vnd.github+json','User-Agent':'Esvitlo-Release-Push'},
    signal:AbortSignal.timeout(15000)
   });
   if(!response.ok)throw Error('GitHub release request failed');
   const release=await response.json();
   const tag=release.tag_name;
   if(release.draft||release.prerelease||typeof tag!=='string'||!releaseTag.test(tag)||
    !release.assets?.some(asset=>asset.state==='uploaded'&&asset.name===`esvitlo-android-${tag.slice(1)}.apk`))return;
   const previous=await readFile(state,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
   if(previous&&tag.localeCompare(previous,'en',{numeric:true})<=0)return;
   if(previous)await messaging.send({
    topic:'app-updates',data:{type:'app-update',tag},
    android:{priority:'normal',ttl:24*60*60*1000,collapseKey:'app-update'}
   });
   await writeFile(state+'.tmp',tag,{mode:0o600});
   await rename(state+'.tmp',state);
  }catch{console.warn('Android release check failed; will retry.');}
  finally{setTimeout(check,30*60*1000).unref();}
 }
 setTimeout(check,15000).unref();
}

export function createPush(dataDir,audit){
 if(!process.env.FCM_PROJECT_ID)return async()=>{};
 const app=initializeApp({credential:applicationDefault(),projectId:process.env.FCM_PROJECT_ID},'esvitlo-push');
 const messaging=getMessaging(app);
 if(dataDir)watchAndroidReleases(messaging,dataDir);
 const push=async(before,after,title,pollId)=>{
  const events=pushEvents(before,after);
  for(let offset=0;offset<events.length;offset+=8){
   const batch=events.slice(offset,offset+8);
   const results=await Promise.allSettled(batch.map(({topic,region,group,body,type})=>messaging.send({
    topic,data:{title,type,body:body.slice(0,800),region,...(group?{group}:{})},
    android:{priority:'high',ttl:30*60*1000}
   })));
   if(audit)results.forEach((result,i)=>{
    const {region,group,type}=batch[i];
    audit('fcm_notification',{pollId,region,group,type,status:result.status==='fulfilled'?'accepted':'failed'});
   });
   if(results.some(result=>result.status==='rejected'))console.warn('FCM delivery failed for one or more topics.');
  }
 };
 push.sendAddress=(token,data)=>messaging.send({token,data,android:{priority:'high',ttl:15*60*1000}});
 return push;
}
