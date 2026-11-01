import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../model';
import { buildGeometry } from '../geometry';
import { createArtworkTrial } from '../studio-handoff';
import { newDocument, recipeFor } from './model';
import { generateArtwork } from './geometry';
import { setArea } from '../polygons';
import { cellCoating } from '../artwork-source';

const bytes=readFileSync(new URL('../../node_modules/@fontsource/anybody/files/anybody-latin-900-normal.woff',import.meta.url));
const font=parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);
describe('Studio lettering / capsule to actual W-type geometry',()=>{
  it.each(['squeeze','capsules'] as const)('resolves %s into real multi-component coatings without turning details into cells',(preset)=>{
    const doc=newDocument();doc.designs.fluid=recipeFor(preset);doc.designs.fluid.text='SOLAR\nORACLE';
    const art=generateArtwork(doc.designs.fluid,font);
    const c=createArtworkTrial(art,doc,{vocV:2,iscMa:1},`studio-${preset}`,{...DEFAULT_CONFIG,measuredWetFilmUm:15,areaBalance:1});
    const g=buildGeometry(c),f=g.fabrication;
    expect(g.cells).toHaveLength(4);expect(f.activeShapes).toHaveLength(4);
    expect(f.activeShapes!.reduce((sum,p)=>sum+p.length,0)).toBeGreaterThan(4);
    expect(f.pattern!.ftoFragmentsValid).toBe(true);
    expect(f.pattern!.flow.pass).toBe(true);
    expect(f.pattern!.flow.monotoneDownwardVerified).toBe(false);
    expect(f.errors).toEqual([]);
    expect(f.cellAreasMm2).toEqual(g.cells.map((_,i)=>setArea(cellCoating(f,i))));
  },30000);
});
