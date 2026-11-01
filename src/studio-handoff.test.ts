import { describe,expect,it } from 'vitest';
import { DEFAULT_CONFIG } from './model';
import { buildGeometry } from './geometry';
import { studioConfig,studioUrl } from './studio-handoff';

describe('type studio geometry handoff',()=>{
 it('reproduces the exact W-type geometry and fabrication inputs',()=>{
  const source={...DEFAULT_CONFIG,electrodeSeed:4361322,subcellCount:6,electrodeJitter:.4};
  const target=studioConfig(studioUrl(source));expect(target).toEqual(source);
  expect(buildGeometry(target!)).toEqual(buildGeometry(source));
 });
 it('rejects malformed or unsupported handoffs',()=>{
  for(const q of ['','?from=type-studio&seed=-1&cells=16&jitter=.3','?from=type-studio&seed=3&cells=3&jitter=.3','?from=type-studio&seed=3&cells=100&jitter=.3','?from=type-studio&seed=3&cells=16&jitter=NaN'])expect(studioConfig(q)).toBeNull();
 });
});
