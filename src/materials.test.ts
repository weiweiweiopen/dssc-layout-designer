import { describe, expect, it } from 'vitest';
import { buildGeometry } from './geometry';
import { DEFAULT_CONFIG, type DesignConfig, type PlateId } from './model';
import { materialForPlate, pasteAssignment, PASTES } from './materials';
import { cellCoating } from './artwork-source';
import { difference, intersect, rectRing, setArea, shape, union } from './polygons';
import { buildFabricationAssets, buildPreviewSvg } from './svg';
import { buildPointCodeArtwork } from './point-code';

function config(patterned: boolean): DesignConfig {
  return { ...DEFAULT_CONFIG, subcellCount: 4, areaBalance: 0, measuredWetFilmUm: 15,
    ...(patterned ? { artwork: { format: 'dssc-vector-artwork-v1' as const, id: 'paste-test', title: 'O', widthMm: 50, heightMm: 60,
      targetVocV: 2, targetIscMa: 1, voltageToleranceV: .35,
      regions: [[rectRing({x:5,y:5,width:40,height:50}),rectRing({x:15,y:15,width:20,height:30})]] } } : {}) };
}
const attrs=(svg:string)=>[...svg.matchAll(/<path\b[^>]*data-subcell-index="(\d+)"[^>]*data-material="(tio2|pt)"[^>]*data-paste="([^"]+)"[^>]*d="([^"]*)"[^>]*>/g)];

describe.each([false,true])('18NR-T / PT-1 distribution (patterned=%s)',(patterned)=>{
  it('alternates the two pastes across both plates and counts only actual coating area',()=>{
    const c=config(patterned),g=buildGeometry(c),report=pasteAssignment(c,g);
    expect(report.cells.map((cell)=>[cell.bigger,cell.smaller])).toEqual([['18NR-T','PT-1'],['PT-1','18NR-T'],['18NR-T','PT-1'],['PT-1','18NR-T']]);
    expect(report.cells.map((cell)=>cell.activeAreaMm2)).toEqual(g.fabrication.cellAreasMm2);
    expect(report.plates[0].areasMm2['18NR-T']).toBeCloseTo(report.plates[1].areasMm2['PT-1'],8);
    expect(report.plates[0].areasMm2['PT-1']).toBeCloseTo(report.plates[1].areasMm2['18NR-T'],8);
    for(const plate of ['glass-6066','glass-6060'] as const){
      const regions=(kind:'tio2'|'pt')=>union(...g.cells.filter(cell=>materialForPlate(cell,plate)===kind).map(cell=>cellCoating(g.fabrication,cell.index)));
      expect(setArea(intersect(regions('tio2'),regions('pt')))).toBeLessThan(1e-7);
      expect(setArea(union(regions('tio2'),regions('pt')))).toBeCloseTo(g.fabrication.totalActiveMm2,5);
      for(const terminal of g.terminals)expect(setArea(intersect(union(regions('tio2'),regions('pt')),shape(rectRing(terminal.contactStrip))))).toBe(0);
    }
  });
  it('always generates four independent masks plus a dual-plate material map',()=>{
    const c=config(patterned),g=buildGeometry(c),codes=buildPointCodeArtwork(c,g),assets=buildFabricationAssets(c,g,codes);
    expect(assets).toHaveLength(10);
    for(const plate of ['glass-6066','glass-6060'] as const)for(const kind of ['tio2','pt'] as const){
      const svg=assets.find(a=>a.id===`screen-${plate}-${kind}`)!.svg,paths=attrs(svg);
      const expected=g.cells.filter(cell=>materialForPlate(cell,plate)===kind).map(cell=>cell.index);
      expect([...new Set(paths.map(p=>Number(p[1])))].sort()).toEqual(expected);
      expect(paths.every(p=>p[2]===kind&&p[3]===PASTES[kind].productCode)).toBe(true);
      expect(svg).not.toMatch(/<text\b/);
      expect(svg).toContain(`pasteProductCode&quot;:&quot;${PASTES[kind].productCode}`);
    }
    const map=buildPreviewSvg(c,g,codes,'materials');
    expect(map).toContain('data-view="materials"');expect(map).not.toContain('ELECTRON_ROUTE');
    expect(map).toContain('1 · 18NR-T');expect(map).toContain('1 · PT-1');
    expect(assets.find(a=>a.id==='materials-reference')!.svg).toBe(map);
  });
  it('mirrors the smaller PT-1 mask once and preserves all bigger-electrode coordinates',()=>{
    const c=config(patterned),g=buildGeometry(c),codes=buildPointCodeArtwork(c,g);
    const pathFor=(plate:PlateId,mirror:boolean)=>attrs(buildPreviewSvg({...c,mirrorGlass6060:mirror},g,codes,plate==='glass-6066'?'pt-6066':'pt-6060')).map(p=>p[4].match(/-?\d+(?:\.\d+)?/g)!.map(Number));
    expect(pathFor('glass-6066',false)).toEqual(pathFor('glass-6066',true));
    const plain=pathFor('glass-6060',false),mirrored=pathFor('glass-6060',true);
    expect(mirrored).toHaveLength(plain.length);
    plain.forEach((points,i)=>points.forEach((n,j)=>expect(mirrored[i][j]).toBeCloseTo(j%2?n:g.glass6060.width-n,7)));
    const mapped=union(...g.cells.map(cell=>cellCoating(g.fabrication,cell.index)));
    expect(setArea(difference(mapped,shape(rectRing(g.overlap))))).toBeLessThan(1e-7);
  });
});
