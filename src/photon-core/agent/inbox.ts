import { randomUUID } from "node:crypto";
import type { InboxItem } from "./types";

export class Inbox {
  private queue: InboxItem[] = [];
  private waiters: Set<() => void> = new Set();

  push(item: Omit<InboxItem, "id">): InboxItem {
    const full = { id: randomUUID(), ...item } as InboxItem;
    this.queue.push(full);
    for (const w of this.waiters) w();
    this.waiters.clear();
    return full;
  }

  // Claim next-step input plus one queued message — harness inbox semantics
  claim(): InboxItem[] | null {
    if (this.queue.length === 0) return null;
    // first waking item plus any immediately queued following items (bounded)
    const firstIdx = this.queue.findIndex(i => i.wake);
    if (firstIdx === -1) return null; // only injected pending — wait for wake
    const batch = this.queue.splice(0, firstIdx + 1);
    // also pull trailing injected that arrived before claim
    while (this.queue.length && !this.queue[0].wake) batch.push(this.queue.shift()!);
    return batch;
  }

  hasPendingWake(): boolean { return this.queue.some(i => i.wake); }
  pendingCount(): number { return this.queue.length; }
  clear() { this.queue = []; }

  async waitForWake(signal?: AbortSignal): Promise<void> {
    if (this.hasPendingWake()) return;
    await new Promise<void>((resolve, reject) => {
      const onWake = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
      const cleanup = () => { this.waiters.delete(onWake); signal?.removeEventListener("abort", onAbort); };
      this.waiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
