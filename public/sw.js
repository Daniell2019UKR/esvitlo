const cacheName='esvitlo-shell-v9';
const shell=['/','/app.js?v=address-outage','/style.css?v=address-outage','/dates.js?v=outline-colors',
 '/regions.js?v=regional','/brand/logo.svg','/brand/favicon.svg','/manifest.webmanifest',
 '/brand/app-192.png','/brand/app-512.png'];
const assets=new Set(shell.slice(1));

self.addEventListener('install',event=>{
 event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(shell.map(path=>new Request(path,{cache:'reload'})))));
});

self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(key=>key.startsWith('esvitlo-shell-')&&key!==cacheName).map(key=>caches.delete(key)));
  await self.clients.claim();
 })());
});

self.addEventListener('fetch',event=>{
 const {request}=event;
 const url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(request.mode==='navigate'&&url.pathname==='/'){
  event.respondWith(fetch(request).catch(async()=>await (await caches.open(cacheName)).match('/')??Response.error()));
 }else if(assets.has(url.pathname+url.search)){
  event.respondWith(fetch(request).catch(async()=>await (await caches.open(cacheName)).match(request)??Response.error()));
 }
});
