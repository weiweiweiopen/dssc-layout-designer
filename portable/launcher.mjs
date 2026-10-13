import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const identity=JSON.parse(fs.readFileSync(path.join(root,'identity.json')));
const logs=path.join(os.homedir(),'Library/Logs/DSSC Layout Portable');
fs.mkdirSync(logs,{recursive:true,mode:0o700});
const url='http://127.0.0.1:18763';
function log(s){fs.appendFileSync(path.join(logs,'launcher.log'),new Date().toISOString()+' '+s+'\n');}
function probe(){return new Promise(resolve=>{const q=http.get(url+'/__dssc_launcher_identity', {timeout:700},res=>{let s='';res.on('data',b=>{s+=b;if(s.length>8192)res.destroy();});res.on('error',()=>resolve('foreign'));res.on('end',()=>{try{const j=JSON.parse(s);resolve(j.app===identity.app&&j.build===identity.build?'ours':'foreign');}catch{resolve('foreign');}});});q.on('timeout',()=>q.destroy());q.on('error',e=>resolve(e.code==='ECONNREFUSED'?'free':'foreign'));});}
if(process.argv.includes('--serve')){
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.woff2':'font/woff2'};
 const server=http.createServer((req,res)=>{
  if(!['127.0.0.1:18763','localhost:18763'].includes(req.headers.host)){res.writeHead(403);res.end();return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,url).pathname);}catch{res.writeHead(400);res.end();return;}
  if(pathname==='/__dssc_launcher_identity'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...identity,pid:process.pid}));return;}
  const dist=path.join(root,'dist'), file=path.resolve(dist,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(dist+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);});
 });
 server.on('error',e=>{console.error(new Date().toISOString(),e.message);process.exit(1);});
 server.listen(18763,'127.0.0.1',()=>console.log(new Date().toISOString(),'Listening',url,'pid',process.pid));
}else{
 try{
  let state=await probe();
  if(state==='foreign')throw new Error('18763 已被其他服務或不同建置版本占用。未開啟網站，也未停止任何程序。請關閉占用服務後重試；網址固定不變，以保留原瀏覽器設定。');
  if(state==='free'){
   const fd=fs.openSync(path.join(logs,'server.log'),'a',0o600);
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{detached:true,stdio:['ignore',fd,fd],cwd:root});child.unref();fs.closeSync(fd);
   const deadline=Date.now()+10000;
   do{await new Promise(r=>setTimeout(r,150));state=await probe();}while(state==='free'&&Date.now()<deadline);
   if(state!=='ours')throw new Error('無法在 10 秒內確認 DSSC 服務，或 18763 已被其他服務占用。請查看 Library/Logs/DSSC Layout Portable/server.log。');
  }
  log('Verified existing/ready service; opening '+url);
  execFileSync('/usr/bin/open',[url],{timeout:10000});
 }catch(e){log('ERROR '+e.message);console.error(e.message);process.exitCode=1;}
}
