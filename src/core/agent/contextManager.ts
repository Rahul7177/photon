import type { TokenUsage } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { estimateTokensForModel } from "../adaptive/tokens";

export interface FitResult { messages:LLMMessage[]; droppedCount:number; usage:TokenUsage; }

/**
 * Fit a conversation into the model context window.
 *
 * Weak local agents use Photon block messages for tool results, so the latest
 * few messages can otherwise crowd out the original user request. In that mode
 * the first user message is a durable task anchor: keep it plus the newest
 * context, while older tool chatter is trimmed first.
 */
export function fitToWindow(system:LLMMessage,history:LLMMessage[],budgetTokens:number,window:number,model?:string,preserveFirstUser=false):FitResult{
  const systemTokens=tokensOf(system,model);const available=Math.max(0,budgetTokens-systemTokens);
  if(!preserveFirstUser)return fitNewest(system,history,available,budgetTokens,window,model);

  const firstUserIndex=history.findIndex(m=>m.role==="user");
  const anchor=firstUserIndex>=0?history[firstUserIndex]:undefined;
  const anchorTokens=anchor?tokensOf(anchor,model):0;
  if(!anchor||anchorTokens>available)return fitNewest(system,history,available,budgetTokens,window,model);

  const newestIndex=history.length-1;
  const newest=history[newestIndex];
  const kept=new Map<number,LLMMessage>();kept.set(firstUserIndex,anchor);let used=anchorTokens;
  let dropped=0;

  // Work backwards, always admitting the newest message. If the newest message
  // is the anchor, the normal path naturally fills from subsequent history.
  for(let i=newestIndex;i>=0;i--){
    if(i===firstUserIndex)continue;
    const t=tokensOf(history[i],model);
    const mustKeep=i===newestIndex;
    if(mustKeep||used+t<=available){
      kept.set(i,history[i]);used+=t;
    }else dropped++;
  }
  const messages=[...kept.entries()].sort((a,b)=>a[0]-b[0]).map(([,m])=>m);
  const usage:TokenUsage={used:systemTokens+used,window:budgetTokens,breakdown:[{label:"System + tools",tokens:systemTokens},{label:"Conversation",tokens:used}]};
  return{messages:[system,...messages],droppedCount:dropped,usage};
}

function fitNewest(system:LLMMessage,history:LLMMessage[],available:number,budgetTokens:number,window:number,model?:string):FitResult{
  const kept:LLMMessage[]=[];let historyTokens=0;let dropped=0;
  for(let i=history.length-1;i>=0;i--){const t=tokensOf(history[i],model);if(i===history.length-1||historyTokens+t<=available){kept.unshift(history[i]);historyTokens+=t;}else{dropped=i+1;break;}}
  const usage:TokenUsage={used:tokensOf(system,model)+historyTokens,window:budgetTokens,breakdown:[{label:"System + tools",tokens:tokensOf(system,model)},{label:"Conversation",tokens:historyTokens}]};
  return{messages:[system,...kept],droppedCount:dropped,usage};
}
function tokensOf(msg:LLMMessage,model?:string):number{let t=4+estimateTokensForModel(msg.content,model);for(const call of msg.tool_calls??[])t+=estimateTokensForModel(call.function.name,model)+estimateTokensForModel(JSON.stringify(call.function.arguments),model);return t;}
