import {access,mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import puppeteer from 'puppeteer-core';
import {closeTestBrowser} from './browser-cleanup.mjs';
const server=process.env.APP_URL?null:await createServer({server:{host:'127.0.0.1',port:0}});await server?.listen();
const base=process.env.APP_URL??server.resolvedUrls.local[0],out=await mkdtemp(join(process.env.TEST_TMPDIR??tmpdir(),'review-pattern-probe-'));
const exe=process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';await access(exe);
const browser=await puppeteer.launch({executablePath:exe,headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']}),p=await browser.newPage(),errors=[];
p.on('pageerror',error=>errors.push(String(error)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),reports={};
async function shot(name){await sleep(400);const image=await(await p.$('[data-testid="review-canvas"] canvas')).screenshot();await writeFile(join(out,`${name}.png`),image);return image.toString('base64');}
async function probe(name){
  const image=await shot(name);
  const report=await p.evaluate(async image=>{
    const im=new Image();im.src=`data:image/png;base64,${image}`;await im.decode();
    const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);const rgba=ctx.getImageData(0,0,c.width,c.height).data;
    const host=document.querySelector('[data-testid="review-canvas"]'),canvas=host.querySelector('canvas'),rect=canvas.getBoundingClientRect();
    const color=(x,y)=>{const i=(y*c.width+x)*4;return[rgba[i],rgba[i+1],rgba[i+2]];};
    const grey=(x,y)=>{const [r,g,b]=color(x,y);return(r+g+b)/3>22&&(r+g+b)/3<160&&Math.max(r,g,b)-Math.min(r,g,b)<30;};
    const summary={},examples=[],emptyExamples=[],emptyColors={},clearSamples=[];let checked=0,ghosts=0,parallax=0,empty=0;
    for(let y=4;y<c.height-4;y+=8)for(let x=4;x<c.width-4;x+=8){
      if(![-2,0,2].every(dy=>[-2,0,2].every(dx=>grey(x+dx,y+dy))))continue;
      const result=host.reviewProbe(rect.left+x/c.width*rect.width,rect.top+y/c.height*rect.height);
      if(!result.hits.length){
        if(result.reference&&result.reference.x>=0&&result.reference.x<=62&&result.reference.y>=0&&result.reference.y<=66){
          empty++;const key=color(x,y).join(',');emptyColors[key]=(emptyColors[key]??0)+1;
          if(key==='41,45,52'&&result.referenceLayers.length===0)clearSamples.push({x,y});
          if(emptyExamples.length<20)emptyExamples.push({pixel:{x,y},rgb:color(x,y),...result});
        }continue;
      }
      const first=result.hits[0];checked++;const kind=`${first.kind}:${Math.abs(first.normalZ??0)>.99?'cap':'wall'}`;summary[kind]=(summary[kind]??0)+1;
      if(Math.abs(first.normalZ??0)>.99&&!first.insideCanonicalXY)ghosts++;
      if(!result.referenceLayers.length)parallax++;
      if(examples.length<30)examples.push({pixel:{x,y},...result});
    }
    return{checked,ghosts,parallax,summary,empty,emptyColors,clearSamples,emptyExamples,examples};
  },image);reports[name]=report;
  if(report.ghosts)throw new Error(`${name}: triangles fill space outside the canonical polygons`);
  // Same camera/pixels, but now capture the actual alpha-enabled canvas rather
  // than the CSS backdrop: the gray gaps must become alpha=0, not a gray film.
  await p.select('[data-testid="review-background"]','transparent');await sleep(250);
  const raw=await p.$eval('[data-testid="review-canvas"]',el=>el.reviewCapture());
  await writeFile(join(out,`${name}-raw-alpha.png`),Buffer.from(raw.split(',')[1],'base64'));
  const alpha=await p.evaluate(async({raw,positions})=>{
    const im=new Image();im.src=raw;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;
    let clear=0,covered=0;for(const {x,y}of positions){if(data[(y*c.width+x)*4+3]===0)clear++;else covered++;}
    let material=0;for(let i=3;i<data.length;i+=4)if(data[i]>100)material++;
    return{samples:positions.length,clear,covered,materialPixels:material};
  },{raw,positions:report.clearSamples});
  report.alpha=alpha;
  if(alpha.samples<10||alpha.clear/alpha.samples<.97||alpha.materialPixels<100)throw new Error(`${name}: expected true transparent gaps and preserved material: ${JSON.stringify(alpha)}`);
  if(name==='iso-40-all')await shot('checkerboard-assembled');
  await p.select('[data-testid="review-background"]','dark');await sleep(200);
}
try{
  await p.setViewport({width:1500,height:1000,deviceScaleFactor:1});await p.goto(base,{waitUntil:'networkidle2'});
  await p.evaluate(()=>{localStorage.setItem('dssc-layout-language','en');localStorage.setItem('dssc-layout-review-3d-v1',JSON.stringify({biggerDye:'burgundy',smallerDye:'custom',smallerColor:'#00bbed',thinLayerScale:40,explodeMm:0,labels:false,background:'dark'}));});
  await p.goto(new URL('?studio=type',base).href,{waitUntil:'networkidle2'});await p.waitForFunction(()=>document.querySelector('.tg-canvas')?.getAttribute('data-pending')==='false');
  await p.$eval('textarea[aria-label="標題文字"]',el=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'energy\nis\naddressable');el.dispatchEvent(new Event('input',{bubbles:true}));});
  await p.select('select[aria-label="字型"]','fraunces');await p.waitForFunction(()=>document.querySelector('.tg-canvas')?.getAttribute('data-pending')==='false');
  await Promise.all([p.waitForNavigation({waitUntil:'networkidle2',timeout:120000}),p.click('button[aria-label="送往 DSSC Layout"]')]);
  await p.waitForFunction(()=>document.querySelector('[data-testid="pattern-panel"]')?.dataset.busy==='false'&&document.querySelector('.title-status')?.dataset.state!=='pending',{timeout:120000});
  const url=new URL(p.url());url.searchParams.set('review-debug','1');await p.goto(url.href,{waitUntil:'networkidle2'});await p.click('[data-view-mode="review-3d"]');
  await p.waitForFunction(()=>document.querySelector('[data-testid="review-canvas"]')?.reviewProbe&&document.querySelector('[data-testid="review-canvas"]')?.dataset.cameraPose,{timeout:60000});
  const trialKey=`dssc-vector-transfer-v1-${url.searchParams.get('artwork')}`,beforeTrial=await p.evaluate(key=>localStorage.getItem(key),trialKey);
  await probe('iso-40-all');
  await p.click('[data-review-toggle="pt"]');await probe('iso-40-no-pt');await p.click('[data-review-toggle="pt"]');
  await p.click('[data-review-toggle="seal"]');await probe('iso-40-no-seal');await p.click('[data-review-toggle="seal"]');
  await p.focus('[data-testid="review-thin-scale"]');await p.keyboard.press('Home');await probe('iso-1-all');
  await p.click('[data-review-view="top"]');await probe('top-1-all');
  await p.focus('[data-testid="review-thin-scale"]');await p.keyboard.press('End');await probe('top-100-all');
  if(await p.evaluate(key=>localStorage.getItem(key),trialKey)!==beforeTrial)throw new Error('3D appearance changed trial fabrication inputs');
  if(errors.length)throw new Error(errors.join('\n'));
  await writeFile(join(out,'probes.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([k,{examples,emptyExamples,emptyColors,clearSamples,...v}])=>[k,{...v,emptyColors:Object.entries(emptyColors).sort((a,b)=>b[1]-a[1]).slice(0,5)}])),null,2));console.log(`PASS: patterned 3D clearances have zero alpha, no phantom cap triangles, and unchanged fabrication inputs.\nArtifacts: ${out}`);
}finally{await closeTestBrowser(browser);await server?.close();}
