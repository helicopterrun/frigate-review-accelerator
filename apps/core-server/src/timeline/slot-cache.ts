import type { SlotResolvedEvent } from "@frigate-review/shared-types";

function slotKey(slotIndex: number, strategy: string): string {
  return `${slotIndex}:${strategy}`;
}

export class SlotCache {
  private frames = new Map<string, SlotResolvedEvent>();
  private maxEntries: number;

  constructor(maxEntries = 600) {
    this.maxEntries = maxEntries;
  }

  has(slotIndex: number, strategy: string): boolean {
    return this.frames.has(slotKey(slotIndex, strategy));
  }

  get(slotIndex: number, strategy: string): SlotResolvedEvent | undefined {
    return this.frames.get(slotKey(slotIndex, strategy));
  }

  getBest(slotIndex: number): SlotResolvedEvent | undefined {
    return this.get(slotIndex, "B") ?? this.get(slotIndex, "A");
  }

  put(frame: SlotResolvedEvent): void {
    if (this.frames.size >= this.maxEntries) {
      // Evict oldest entry
      const firstKey = this.frames.keys().next().value;
      if (firstKey !== undefined) this.frames.delete(firstKey);
    }
    this.frames.set(slotKey(frame.slotIndex, frame.resolvedStrategy), frame);
  }

  clear(): void {
    this.frames.clear();
  }

  invalidateTypeB(): void {
    for (const key of this.frames.keys()) {
      if (key.endsWith(":B")) {
        this.frames.delete(key);
      }
    }
  }
}
