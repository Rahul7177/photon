import * as vscode from "vscode";
import type { BenchResult } from "../shared/types";
import { BENCH_VERSION } from "../core/bench/bench";
const KEY="photon.bench";const MAX=200;
export class BenchStore{
  constructor(private readonly context:vscode.ExtensionContext){}
  all():BenchResult[]{return this.context.globalState.get<BenchResult[]>(KEY,[]);}
  /** Return the latest current-methodology result per model; stale rubrics are not used for ranking. */
  byModel(methodologyVersion=BENCH_VERSION):Map<string,BenchResult>{const map=new Map<string,BenchResult>();for(const r of this.all()){if(r.methodologyVersion!==methodologyVersion)continue;const prev=map.get(r.model);if(!prev||r.ranAt>prev.ranAt)map.set(r.model,r);}return map;}
  async upsert(result:BenchResult):Promise<void>{const key=(r:BenchResult)=>`${r.model}|${r.hardwareClass}|${r.methodologyVersion}`;const all=this.all().filter(r=>key(r)!==key(result));all.push(result);all.sort((a,b)=>b.ranAt-a.ranAt);await this.context.globalState.update(KEY,all.slice(0,MAX));}
}
