import * as vscode from "vscode";
import { SessionRegistry } from "../session/store";
import { AgentRegistry } from "../agent/agent";
import { ToolPipeline } from "../tools/pipeline";
import { SystemPromptRegistry } from "../systemPrompt/registry";
import { AgentLoop } from "../loop/agentLoop";
import { builtinTools } from "../../core/tools/builtin";
import { McpManager } from "../../core/tools/mcp/bridge";
import { ProviderManager } from "../../core/llm/providerManager";
import { OllamaProvider } from "../../core/llm/providers/ollamaProvider";
import { OllamaClient } from "../../core/ollama/client";
import { bridgeLegacyProvider } from "../llm/types.v2";

export interface PhotonContext {
  sessions: SessionRegistry;
  agents: AgentRegistry;
  tools: ToolPipeline;
  systemPrompt: SystemPromptRegistry;
  llm: ProviderManager;
  llmAdapter: ReturnType<typeof bridgeLegacyProvider>;
  loop: AgentLoop;
  mcp: McpManager;
  client: OllamaClient;
  output: vscode.OutputChannel;
}

export function bootPhoton(context: vscode.ExtensionContext, output: vscode.OutputChannel): PhotonContext {
  const cfg = vscode.workspace.getConfiguration("photon");
  const client = new OllamaClient({ baseUrl: cfg.get<string>("ollama.baseUrl", "http://localhost:11434"), timeoutMs: cfg.get<number>("ollama.requestTimeoutMs", 180000), keepAlive: "30m" });
  const ollama = new OllamaProvider(client);
  const llm = new ProviderManager([ollama as any]);
  const bridged = bridgeLegacyProvider(llm as any);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const tools = new ToolPipeline();
  tools.registerAll(builtinTools() as any);
  const systemPrompt = new SystemPromptRegistry();
  const mcp = new McpManager({ register: (t:any)=>tools.register(t), registerAll: (ts:any)=>tools.registerAll(ts), unregisterByPrefix: (p:string)=>{ for(const n of [...(tools as any).tools.keys()]) if(n.startsWith(p)) (tools as any).tools.delete(n); } } as any, (msg:string)=>output.appendLine(`[mcp] ${msg}`));
  const loop = new AgentLoop({
    llm: bridged,
    tools,
    systemPrompt,
    workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
    reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
    buildPlan: () => null as any,
    buildToolContext: (signal, capability) => ({
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      requestApproval: async () => true,
      signal, log: (m:string)=>output.appendLine(m), webSearchProvider: cfg.get<any>("webSearch.provider","duckduckgo"),
      findFiles: async ()=>[], capability, getDiagnostics: async ()=>[], todos: [],
    }),
  });
  return { sessions, agents, tools, systemPrompt, llm, llmAdapter: bridged, loop, mcp, client, output };
}
