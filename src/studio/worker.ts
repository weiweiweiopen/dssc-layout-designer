import { loadFont } from "./fonts";
import { generateArtwork } from "./geometry";
import type { Recipe, StudioDocument } from "./model";

// No DOM, image overlay or Layout state: the worker resolves only artwork geometry.
self.onmessage = async (event: MessageEvent<{ recipe: Recipe; customFont?: StudioDocument["customFont"] }>) => {
  try {
    const font = await loadFont(event.data.recipe.font, event.data.customFont);
    self.postMessage({ art: generateArtwork(event.data.recipe, font) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
