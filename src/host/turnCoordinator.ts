import type { Attachment } from "../shared/types";
import type { HostMessage } from "../shared/protocol";

export interface TurnCoordinatorDeps {
  post: (msg: HostMessage) => void;
  output: { appendLine: (line: string) => void };
}

/**
 * Coordinates turn execution lifecycle, cancellation signals, and sequential prompt queueing.
 */
export class TurnCoordinator {
  private turnAbort?: AbortController;
  private promptQueue: Array<{ text: string; attachments?: Attachment[] }> = [];
  private drainingQueue = false;

  constructor(private readonly deps: TurnCoordinatorDeps) {}

  isTurnActive(): boolean {
    return !!this.turnAbort && !this.turnAbort.signal.aborted;
  }

  createTurnSignal(): AbortSignal {
    if (this.turnAbort && !this.turnAbort.signal.aborted) {
      this.turnAbort.abort();
    }
    this.turnAbort = new AbortController();
    return this.turnAbort.signal;
  }

  abortTurn(): void {
    if (this.turnAbort && !this.turnAbort.signal.aborted) {
      this.turnAbort.abort();
    }
    this.turnAbort = undefined;
  }

  clearQueue(): void {
    this.promptQueue = [];
  }

  getQueueLength(): number {
    return this.promptQueue.length;
  }

  async enqueueOrRun(
    prompt: { text: string; attachments?: Attachment[] },
    runPrompt: (text: string, attachments?: Attachment[]) => Promise<void>
  ): Promise<void> {
    if (this.isTurnActive()) {
      this.promptQueue.push(prompt);
      this.deps.post({
        type: "status",
        payload: {
          kind: "running",
          detail: `Queued (${this.promptQueue.length}) — will run after current turn.`,
        },
      });
      return;
    }

    try {
      await runPrompt(prompt.text, prompt.attachments);
    } finally {
      if (this.promptQueue.length && !this.drainingQueue) {
        this.drainingQueue = true;
        try {
          while (this.promptQueue.length) {
            const next = this.promptQueue.shift()!;
            try {
              await runPrompt(next.text, next.attachments);
            } catch (err) {
              this.deps.output.appendLine(`[queue] Prompt failed: ${(err as Error).message}`);
            }
          }
        } finally {
          this.drainingQueue = false;
        }
      }
    }
  }
}

