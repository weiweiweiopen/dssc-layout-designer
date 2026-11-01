import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './model';
import { createArtworkTrial, persistArtworkTrial, readArtworkTrial, transferArtwork } from './studio-handoff';
import { newDocument } from './studio/model';
import type { Artwork } from './studio/geometry';
import { rectRing } from './polygons';
import { parseDesignArtwork } from './artwork-source';

const art: Artwork = { format: 'type-geometry-artwork-v1', stage: 'resolved-artwork-not-fabrication', units: 'mm', toleranceMm: .025,
  width: 50, height: 60, a: [[rectRing({x:5,y:5,width:40,height:50}),rectRing({x:15,y:15,width:20,height:30})]], b: [], elements:[], dividers:[], mask:[], character:[],
  stats:{areaA:1400,areaB:1600,coverage:1400/3000,components:1,holes:1,vertices:8},warnings:[] };
class MemoryStore {
  map = new Map<string,string>();
  get length(){return this.map.size;}
  key(i:number){return [...this.map.keys()][i]??null;}
  getItem(k:string){return this.map.get(k)??null;}
  setItem(k:string,v:string){this.map.set(k,v);}
  removeItem(k:string){this.map.delete(k);}
}
describe('resolved artwork handoff',()=>{
  it('transfers complete geometry, holes, recipe and process reference without overwriting Layout',()=>{
    const store=new MemoryStore(), original={...DEFAULT_CONFIG,electrodeSeed:555,measuredWetFilmUm:16,referenceIscMa:27};
    const old=JSON.stringify(original);store.setItem('w-series-voronoi-layout-v6',old);
    const doc=newDocument(), url=transferArtwork(art,doc,{vocV:2,iscMa:1},store), loaded=readArtworkTrial(url,store);
    expect(loaded.error).toBe('');expect(loaded.config!.artwork!.regions[0]).toHaveLength(2);
    expect(JSON.parse(loaded.config!.artwork!.recipeJson!)).toEqual(doc);
    expect(loaded.config!.measuredWetFilmUm).toBe(16);expect(loaded.config!.referenceIscMa).toBe(27);
    expect(loaded.config!.subcellCount).toBe(4);
    expect(store.getItem('w-series-voronoi-layout-v6')).toBe(old);
    expect(loaded.autoSearch).toBe(true);
    const updated={...loaded.config!,measuredWetFilmUm:15.5,electrodeSeed:1234};persistArtworkTrial(updated,store);
    const reopened=readArtworkTrial(url,store);
    expect(reopened.config!.measuredWetFilmUm).toBe(15.5);expect(reopened.config!.electrodeSeed).toBe(1234);expect(reopened.autoSearch).toBe(false);
    expect(store.getItem('w-series-voronoi-layout-v6')).toBe(old);
  });
  it('distinguishes missing / malformed artwork trials from a normal Layout visit',()=>{
    const store=new MemoryStore();
    expect(readArtworkTrial('',store).requested).toBe(false);
    const missing=readArtworkTrial('?from=type-studio&artwork=missing',store);
    expect(missing.requested).toBe(true);expect(missing.config).toBeNull();expect(missing.error).toContain('不存在');
    expect(readArtworkTrial('?from=type-studio&artwork=',store).error).toContain('無效');
    store.setItem('dssc-vector-transfer-v1-bad','{"format":"dssc-studio-transfer-v1","config":{}}');
    expect(readArtworkTrial('?from=type-studio&artwork=bad',store).config).toBeNull();
  });
  it('rejects invalid source coordinates and unreasonable target / geometry payloads',()=>{
    const source=createArtworkTrial(art,newDocument(),{vocV:2,iscMa:1},'test').artwork!;
    expect(()=>parseDesignArtwork({...source,regions:[[[{x:NaN,y:0},{x:1,y:2},{x:0,y:3}]]]})).toThrow();
    expect(()=>parseDesignArtwork({...source,targetIscMa:-1})).toThrow();
    expect(()=>parseDesignArtwork({...source,regions:[[[{x:-1,y:0},{x:1,y:2},{x:0,y:3}]]]})).toThrow();
  });
});
