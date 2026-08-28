import type { AdaptivePlan, Mode } from "../../shared/types";
import { buildSystemPrompt as buildBase } from "../../core/prompts/system";

export interface PromptSection {
  id: string;
  content: string | ((ctx: { mode: Mode; plan: AdaptivePlan; workspaceName?: string }) => string);
  priority: number; // higher = later (closer to user)
}

export class SystemPromptRegistry {
  private sections = new Map<string, PromptSection>();

  register(id: string, section: Omit<PromptSection, "id">): () => void {
    this.sections.set(id, { id, ...section });
    return () => this.sections.delete(id);
  }

  assemble(opts: { mode: Mode; plan: AdaptivePlan; toolInstructions: string; workspaceName?: string; workspaceMap?: string; retrievedContext?: string }): string {
    const base = buildBase(opts as any);
    // registered sections are injected after core but before extras — ordered by priority
    const extras = [...this.sections.values()].sort((a,b)=>a.priority-b.priority).map(s => typeof s.content === "function" ? (s.content as any)(opts) : s.content).filter(Boolean).join("\n\n");
    return extras ? `${base}\n\n${extras}` : base;
  }
}
