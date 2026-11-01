import type { Artwork } from "./geometry";
import type { Recipe, StudioDocument } from "./model";

interface Job {
  kind: "preview" | "variant";
  recipe: Recipe;
  customFont?: StudioDocument["customFont"];
  resolve: (art: Artwork) => void;
  reject: (error: Error) => void;
}
export class Superseded extends Error {}

/** One in-flight job; coalesce pending previews while keeping the UI responsive. */
export class StudioEngine {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private active: Job | null = null;
  private queue: Job[] = [];
  private closed = false;
  constructor() {
    this.worker.onmessage = (event: MessageEvent<{ art?: Artwork; error?: string }>) => {
      const current = this.active; this.active = null;
      if (event.data.error) current?.reject(new Error(event.data.error));
      else if (event.data.art) current?.resolve(event.data.art);
      this.next();
    };
    this.worker.onerror = (event) => {
      const error = new Error(`向量引擎載入失敗：${event.message}`);
      this.active?.reject(error); this.active = null;
      this.queue.splice(0).forEach((job) => job.reject(error));
    };
  }
  run(recipe: Recipe, customFont?: StudioDocument["customFont"], kind: Job["kind"] = "preview"): Promise<Artwork> {
    if (this.closed) return Promise.reject(new Superseded());
    return new Promise((resolve, reject) => {
      if (kind === "preview") {
        this.queue = this.queue.filter((job) => { if (job.kind === "preview") { job.reject(new Superseded()); return false; } return true; });
      }
      this.queue.push({ recipe, customFont, kind, resolve, reject });
      this.next();
    });
  }
  private next() {
    if (this.closed || this.active || !this.queue.length) return;
    this.active = this.queue.shift()!;
    this.worker.postMessage({ recipe: this.active.recipe, customFont: this.active.customFont });
  }
  dispose() {
    this.closed = true; this.worker.terminate(); this.active?.reject(new Superseded()); this.active = null;
    this.queue.splice(0).forEach((job) => job.reject(new Superseded()));
  }
}
