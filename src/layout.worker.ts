import type { DesignConfig } from './model';
import { deriveDesign, searchArtworkConfiguration } from './design';

self.onmessage = (event: MessageEvent<{ kind: 'derive' | 'search'; config: DesignConfig }>) => {
  try {
    if (event.data.kind === 'search') self.postMessage({ kind: 'search', result: searchArtworkConfiguration(event.data.config,
      (completed, total) => self.postMessage({ kind: 'progress', completed, total })) });
    else self.postMessage({ kind: 'derive', result: deriveDesign(event.data.config) });
  } catch (error) { self.postMessage({ kind: 'error', error: error instanceof Error ? error.message : String(error) }); }
};
