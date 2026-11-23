// The DTEK shutdown page conditionally publishes #modal-attention and opens it
// with MicroModal.show('modal-attention'). Its FAQ mentions emergency outages
// even when none are announced, so searching the whole page is unsafe.
const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const ignoredTags = new Set(['script','style','template','noscript','svg','button']);
const entities = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',rsquo:'’',lsquo:'‘',ndash:'–',mdash:'—',hellip:'…'};

function decode(text) {
 return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all,key) => {
  if(key[0]!=='#') return entities[key.toLowerCase()] ?? all;
  const value=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
  return value>0&&value<=0x10ffff?String.fromCodePoint(value):all;
 }).replace(/\s+/g,' ').trim();
}

function attribute(tag,name) {
 const match=tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i'));
 return match?.[1]??match?.[2]??match?.[3]??null;
}

function attentionText(html) {
 const stack=[];const chunks=[];let found=false;let finished=false;
 // Tokenize tags to respect nested containers; a non-greedy div regex truncates
 // the upstream modal at the first nested closing div.
 for(const token of html.matchAll(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g)) {
  const part=token[0];
  if(part.startsWith('<!--'))continue;
  if(part.startsWith('</')) {
   const name=part.match(/^<\/\s*([\w-]+)/)?.[1]?.toLowerCase();
   const index=stack.findLastIndex(item=>item.name===name);
   if(index>=0) {
    const removed=stack.splice(index);
    if(removed.some(item=>item.attention)){finished=true;break;}
    if(found)chunks.push(' ');
   }
   continue;
  }
  if(part.startsWith('<')) {
   const name=part.match(/^<\s*([\w-]+)/)?.[1]?.toLowerCase();
   if(!name)continue;
   const parentIgnored=stack.some(item=>item.ignored);
   const hidden=attribute(part,'hidden')!==null||/\shidden(?:\s|>|=)/i.test(part)||/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribute(part,'style')||'');
   // aria-hidden=true is the initial state of a MicroModal that is opened on
   // DOMContentLoaded; explicit hidden/display:none copies are not notices.
   const attention=!parentIgnored&&!hidden&&attribute(part,'id')==='modal-attention';
   if(attention)found=true;
   const item={name,attention,ignored:parentIgnored||ignoredTags.has(name)||hidden};
   if(!voidTags.has(name)&&!part.endsWith('/>'))stack.push(item);
   if(found)chunks.push(' ');
   continue;
  }
  if(found&&stack.some(item=>item.attention)&&!stack.some(item=>item.ignored))chunks.push(part);
 }
 return {found,finished,text:decode(chunks.join(''))};
}

export function extractEmergency(html) {
 const unknown={active:null,message:null,areas:[]};
 if(typeof html!=='string'||!html.trim())return unknown;
 const attention=attentionText(html);
 if(attention.found&&!attention.finished)return unknown;
 if(attention.found&&!attention.text.trim())return unknown;
 const recognized=/DisconSchedule\.fact\s*=\s*\{/.test(html)||(/class=["'][^"']*discon_schedule/.test(html)&&/MicroModal\.show\(['"]modal-attention['"]\)/.test(html));
 if(!attention.found)return recognized?{active:false,message:null,areas:[]}:unknown;
 return classifyEmergency(attention.text);
}

function noticeSignature(notice) {
 if(notice?.active!==true)return notice?.active===false?'clear':null;
 const text=(notice.message??'').normalize('NFC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/gu,'')
  .trim().replace(/\s*[—–-]\s*сайт\s+дтек\.?$/iu,'').replace(/[«»“”"]/gu,'')
  .replace(/\s+/gu,' ').trim().replace(/[.!?]+$/u,'').toLocaleLowerCase('uk');
 return JSON.stringify([notice.kind??'emergency',text]);
}

export function confirmEmergency(current, candidate, incoming, checkedAt) {
 const signature=noticeSignature(incoming);
 if(signature===null)return {emergency:{...current,stale:true},candidate:null};
 if(signature===noticeSignature(current))return {
  emergency:{...current,checkedAt,stale:false},candidate:null
 };
 if(candidate?.signature===signature)return {emergency:{...incoming,checkedAt,stale:false},candidate:null};
 return {emergency:{...current,stale:true},candidate:{signature}};
}

export function classifyEmergency(message) {
 const declarations=message.replace(/(?:уникнути|уникати|запобігти|недопущення|избежать|предотвратить)\s+(?:можлив[\p{L}]*\s+)?(?:екстрен[\p{L}]*|аварійн[\p{L}]*|экстрен[\p{L}]*|аварийн[\p{L}]*)\s+(?:відключен[\p{L}]*|отключен[\p{L}]*)/giu,'');
 const emergency=/\b(?:emergency)\b|екстрен(?:і|их|ні|них|е|ого|ий)|экстрен(?:ные|ных|ное)/i.test(declarations);
 const unplanned=/(?:аварійн\p{L}*\s+(?:відключен\p{L}*|знеструмлен\p{L}*)|зникло\s+світло|залишил\p{L}*\s+без\s+світла|відсутн\p{L}*\s+електропостачання|знеструмлен[оіа])/iu.test(declarations);
 // A notice may cancel outages in one district while introducing them in
 // another. An explicit active declaration always wins over cancellation;
 // do not apply a cancellation word to the entire regional announcement.
 const activeDeclaration=message.split(/[.!?;,]|\s+(?:але|однак|тоді\s+як)\s+/iu).some(clause=>{
  const plain=clause.replace(/не\s+(?:діють|застосовуються|введен[\p{L}]*|запроваджен[\p{L}]*)/giu,'');
  if(!/відключен/iu.test(plain))return false;
  return /(?:^|[^\p{L}])(?:введен[\p{L}]*|вводять|запроваджен[\p{L}]*|тривають|діють|застосовуються|продовжуються|продовжено)(?:$|[^\p{L}])/iu.test(plain);
 });
 // Explicit cancellation with no competing active declaration removes the
 // banner. Uncertain mixed wording stays visible with the full source text.
 const cancelled=/(?:екстрен[\p{L}]*\s+відключен[\p{L}]*.{0,45}(?:скасовано|скасовані|не\s+застосовуються|завершено|припинено|відмінено))|(?:(?:скасовано|скасовані|не\s+застосовуються|завершено|припинено|відмінено|відбій).{0,45}екстрен[\p{L}]*\s+відключен)/iu.test(message);
 const emergencyActive=emergency&&(!cancelled||activeDeclaration);
 const restored=/(?:аварійн\p{L}*\s+відключен\p{L}*\s+(?:скасован\p{L}*|завершен\p{L}*)|електропостачання\s+(?:повністю\s+)?відновлено|відновлено\s+електропостачання)/iu.test(message);
 const unplannedActive=unplanned&&!restored;
 if(!emergencyActive&&!unplannedActive)return {active:false,message:null,areas:[]};
 // Keep geographic wording exactly as published instead of inventing an area
 // list from the subscriber's power group (groups cannot identify districts).
 const areas=[...message.matchAll(/(?:^|[\s.!?])[УуВв]\s+((?:частині\s+)?[\p{L}’'ʼ-]+(?:\s+(?:та|і|й)\s+[\p{L}’'ʼ-]+|,\s*[\p{L}’'ʼ-]+)*\s+район(?:і|ах|у|ів|и))/gu)].map(match=>match[1]);
 return {active:true,kind:emergencyActive?(unplannedActive?'mixed':'emergency'):'unplanned',message,areas:[...new Set(areas)]};
}
