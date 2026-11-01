import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { unzipSync, strFromU8 } from 'fflate';
import { closeTestBrowser } from './browser-cleanup.mjs';

const server=process.env.APP_URL?null:await createServer({server:{host:'127.0.0.1',port:0}});await server?.listen();
const base=process.env.APP_URL??server.resolvedUrls.local[0];
const executablePath=process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';await access(executablePath);
const output=await mkdtemp(join(process.env.TEST_TMPDIR??tmpdir(),'paste-distribution-'));
const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']}),page=await browser.newPage(),errors=[];
page.on('pageerror',e=>errors.push(String(e)));
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
const ready=()=>page.waitForFunction(()=>document.querySelector('.title-status')?.dataset.state==='pass'&&document.querySelector('[data-testid="pattern-panel"]')?.dataset.busy!=='true',{timeout:120000});
async function captureDownloads(){await page.evaluate(()=>{
  window.__downloads=[];window.__blobs=new Map();const create=URL.createObjectURL.bind(URL);
  URL.createObjectURL=blob=>{const url=create(blob);window.__blobs.set(url,blob);return url;};
  HTMLAnchorElement.prototype.click=function(){if(this.download)window.__downloads.push({name:this.download,blob:window.__blobs.get(this.href)});};
});}
async function exercise(name){
  await ready();await captureDownloads();
  const rows=await page.$$eval('[data-paste-cell]',nodes=>nodes.map(n=>({index:Number(n.dataset.pasteCell),bigger:n.dataset.biggerPaste,smaller:n.dataset.smallerPaste})));
  ensure(rows.length>=2&&rows.every(r=>r.bigger===(r.index%2?'18NR-T':'PT-1')&&r.smaller===(r.index%2?'PT-1':'18NR-T')),`${name}: material table lost W-series pairing`);
  await page.click('[data-view-mode="materials"]');await page.waitForSelector('.preview-frame svg[data-view="materials"]');
  ensure(await page.$eval('.preview-frame svg',svg=>svg.textContent.includes('18NR-T')&&svg.textContent.includes('PT-1')&&!svg.querySelector('[id^="ELECTRON_ROUTE"]')),`${name}: material map is absent or still an electron-route view`);
  await page.screenshot({path:join(output,`${name}-distribution.png`)});
  const masks=[['glass-6066','18NR-T','tio2','bigger'],['pt-6066','PT-1','pt','bigger'],['glass-6060','18NR-T','tio2','smaller'],['pt-6060','PT-1','pt','smaller']];
  for(let i=0;i<masks.length;i++){
    const [view,product,kind,role]=masks[i];await page.click(`[data-view-mode="${view}"]`);await page.waitForSelector(`.preview-frame svg[data-view="${view}"]`);
    const codes=await page.$$eval('.preview-frame svg path[data-material]',nodes=>nodes.map(n=>({code:n.dataset.paste,kind:n.dataset.material})));
    ensure(codes.length&&codes.every(c=>c.code===product&&c.kind===kind),`${name}/${view}: wrong paste rendered`);
    await page.locator(`[data-testid="download-${role}-${kind}"]`).click();
    await page.waitForFunction(n=>window.__downloads.length===n,{},i+1);
  }
  await page.locator('button::-p-text(Export Vector ZIP)').click();await page.waitForFunction(()=>window.__downloads.length===5,{timeout:60000});
  const archive=new Uint8Array(await page.evaluate(async()=>Array.from(new Uint8Array(await window.__downloads[4].blob.arrayBuffer()))));
  const files=unzipSync(archive),design=JSON.parse(strFromU8(files['design.json'])),report=design.pasteAssignment;
  ensure(Object.keys(files).length===25&&files['svg-layered/materials-reference.svg'],`${name}: missing reference or paste masks in ZIP`);
  ensure(report.products.tio2.productCode==='18NR-T'&&report.products.pt.productCode==='PT-1',`${name}: paste provenance missing`);
  for(let i=0;i<4;i++){
    const data=new Uint8Array(await page.evaluate(async i=>Array.from(new Uint8Array(await window.__downloads[i].blob.arrayBuffer())),i));
    const dv=new DataView(data.buffer,data.byteOffset,data.byteLength),offset=dv.getUint32(4,true),count=dv.getUint16(offset,true),tags=new Map();
    for(let j=0;j<count;j++){const p=offset+2+j*12;tags.set(dv.getUint16(p,true),dv.getUint16(p+2,true)===3?dv.getUint16(p+8,true):dv.getUint32(p+8,true));}
    ensure(tags.get(258)===1&&tags.get(262)===0,`${name}: paste download is not WhiteIsZero 1-bit TIFF`);
    const [,product,,role]=masks[i],plate=report.plates.find(p=>p.role===role),expected=plate.areasMm2[product];
    const w=tags.get(256),h=tags.get(257),start=tags.get(273),stride=Math.ceil(w/8),pop=Array.from({length:256},(_,n)=>n.toString(2).replace(/0/g,'').length);let black=0;
    for(let y=0;y<h;y++)for(let x=0;x<stride;x++){let b=data[start+y*stride+x];if(x===stride-1&&w%8)b&=0xff<<(8-w%8);black+=pop[b];}
    ensure(Math.abs(black*(25.4/1200)**2-expected)<Math.max(1,expected*.02),`${name}: ${role} ${product} TIFF pixels do not match actual coating area`);
  }
  await page.click('[data-testid="language-zh-TW"]');
  ensure(await page.$eval('[data-testid="paste-distribution"]',e=>e.textContent.includes('材料分布')),`${name}: material labels did not translate`);
  await page.click('[data-testid="language-en"]');
  return {cells:rows.length,vectorFiles:Object.keys(files).length,tiffMasks:4};
}
try{
  await page.setViewport({width:1500,height:1050});await page.goto(base,{waitUntil:'networkidle2'});await ready();await page.click('[data-testid="language-en"]');
  const original=await exercise('original');
  await page.evaluate(()=>{const key='w-series-voronoi-layout-v6',c=JSON.parse(localStorage.getItem(key));c.measuredWetFilmUm=15;localStorage.setItem(key,JSON.stringify(c));});
  await page.goto(new URL('?studio=type',base).href,{waitUntil:'networkidle2'});await page.waitForFunction(()=>document.querySelector('.tg-canvas')?.getAttribute('data-pending')==='false');
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle2',timeout:120000}),page.click('button[aria-label="送往 DSSC Layout"]')]);await page.waitForSelector('[data-testid="pattern-panel"]',{timeout:120000});
  const patterned=await exercise('studio-pattern');ensure(!errors.length,errors.join('\n'));
  await writeFile(join(output,'result.json'),JSON.stringify({status:'PASS',original,patterned,checks:'both modes: W-series products, material reference, four independent masks and 1-bit TIFF pixel areas, bilingual labels, complete vector assignment'},null,2));
  console.log(`18NR-T / PT-1 browser distribution: PASS\nArtifacts: ${output}`);
}catch(error){await page.screenshot({path:join(output,'failure.png')});console.error(`Artifacts: ${output}`);throw error;}
finally{await closeTestBrowser(browser);await server?.close();}
