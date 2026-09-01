import { clamp, fail, ok, outputBudget, type Tool } from "../types";

export const webSearchTool: Tool = {
  spec: {
    name: "web_search",
    summary: "Search the web for current/external information. Returns URLs and snippets. After searching, use web_fetch on the best URL to read the full page.",
    params: [{ name: "query", type: "string", required: true, description: "What to search for. Be specific and include keywords." }],
    sideEffecting: false,
    priority: 13,
    minTier: "low",
    tags: ["web", "read", "search"],
    risk: "network",
    concurrency: "safe_parallel",
    idempotency: "idempotent",
    example: '[TOOL web_search]\nquery: vite react plugin options 2026\n[/TOOL]\n\nAfter getting results, call web_fetch on the best URL.',
  },
  async execute(args, ctx) {
    if (ctx.webSearchProvider === "none") return fail("Web search is disabled in Photon settings.");
    const query = (args.query as string)?.trim();
    if (!query) return fail("Provide a search query.");
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]);

      // Weather is a high-value current-data case where search-engine HTML is
      // unnecessarily fragile. Keep it behind the same native `web_search`
      // tool, but use a public current-weather endpoint first so a valid query
      // produces usable evidence for the model instead of an empty result set.
      const weather = extractWeatherLocation(query);
      if (weather) {
        const direct = await fetchCurrentWeather(weather, signal);
        if (direct) return ok(clamp(direct, outputBudget(ctx)));
      }

      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        method: "GET",
        signal,
        headers: { "User-Agent": "Photon VS Code extension" },
      });
      if (!res.ok) return fail(`Search failed with status ${res.status}.`);
      const html = await res.text();
      const results = parseDuckDuckGo(html).slice(0, ctx.capability === "max" ? 8 : 5);
      if (!results.length) return ok("No results found. Try different keywords.");
      const resultList = results.map((r,i)=>`${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return ok(clamp(resultList, outputBudget(ctx)));
    } catch(e) {
      if((e as Error).name==="AbortError")return fail("Search cancelled.");
      return fail(`Search error: ${(e as Error).message}`);
    }
  },
};

export const webFetchTool: Tool = {
  spec: {
    name: "web_fetch",
    summary: "Read a web page or raw file. Use this after web_search to read the full content of a URL found in search results.",
    params: [
      { name: "url", type: "string", required: true, description: "Public https:// URL to fetch. Copy from web_search results." },
      { name: "start_line", type: "number", required: false, description: "First non-empty line to return (for long pages)." },
    ],
    sideEffecting: false,
    priority: 14,
    minTier: "low",
    tags: ["web", "read"],
    risk: "network",
    concurrency: "safe_parallel",
    idempotency: "idempotent",
    example: '[TOOL web_fetch]\nurl: https://raw.githubusercontent.com/user/repo/main/README.md\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rawUrl = (args.url as string)?.trim();
    if (!rawUrl || !/^https:\/\//i.test(rawUrl)) return fail("Only public HTTPS URLs are allowed.");
    if (!isPublicUrl(rawUrl)) return fail("Blocked URL: Photon only fetches public HTTPS hosts, not localhost/private/link-local addresses.");
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]);
      const res = await fetch(rawUrl, { signal, headers: { "User-Agent": "Photon VS Code extension" } });
      if (!res.ok) return fail(`Request failed with status ${res.status}.`);
      const contentType = res.headers.get("content-type") ?? "";
      const body = (await res.text()).slice(0, 2_000_000);
      const text = /html/i.test(contentType) ? htmlToText(body) : body;
      const lines = text.split("\n").filter(l=>l.trim()!=="");
      const start = Math.max(1, Math.floor(Number(args.start_line)||1));
      if(start>lines.length)return ok(`Page has ${lines.length} non-empty lines; start_line ${start} is past the end.`);
      const cap=400; const slice=lines.slice(start-1,start-1+cap);
      const note=start-1+cap<lines.length?`\n… [${lines.length-(start-1+cap)} more lines. Call again with start_line: ${start+cap}]`:"";
      return ok(clamp(slice.join("\n")+note, outputBudget(ctx)));
    } catch(e) {
      if((e as Error).name==="AbortError")return fail("Fetch cancelled.");
      return fail(`web_fetch error: ${(e as Error).message}`);
    }
  },
};

function extractWeatherLocation(query:string):string|undefined{
  const m=query.match(/\b(?:weather|forecast|temperature)\b[\s\S]*?\b(?:in|of|for|at)\s+(.+?)\s*$/i);
  if(!m)return undefined;
  const cleaned=m[1]
    .replace(/\b(right now|right away|today|tonight|tomorrow|this week|currently|now)\b[\s,.-]*$/i,"")
    .trim()
    .replace(/[?.!,]+$/g,"");
  return cleaned.length>=2?cleaned:undefined;
}

async function fetchCurrentWeather(location:string, signal:AbortSignal):Promise<string|undefined>{
  try{
    const url=`https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res=await fetch(url,{signal,headers:{"User-Agent":"Photon VS Code extension"}});
    if(!res.ok)return undefined;
    const json=await res.json() as {
      current_condition?:Array<{temp_C?:string;FeelsLikeC?:string;humidity?:string;weatherDesc?:Array<{value?:string}>;windspeedKmph?:string;uvIndex?:string}>;
      nearest_area?:Array<{areaName?:Array<{value?:string}>;region?:Array<{value?:string}>;country?:Array<{value?:string}>}>;
    };
    const cur=json.current_condition?.[0];
    if(!cur)return undefined;
    const area=json.nearest_area?.[0];
    const place=area?.areaName?.[0]?.value??location;
    const region=area?.region?.[0]?.value;
    const country=area?.country?.[0]?.value;
    const bits=[`${cur.weatherDesc?.[0]?.value??"Current conditions"}.`,cur.temp_C?`Temperature: ${cur.temp_C}°C.`:"",cur.FeelsLikeC?`Feels like: ${cur.FeelsLikeC}°C.`:"",cur.humidity?`Humidity: ${cur.humidity}%.`:"",cur.windspeedKmph?`Wind: ${cur.windspeedKmph} km/h.`:"",cur.uvIndex?`UV index: ${cur.uvIndex}.`:""] .filter(Boolean);
    return `Current weather for ${[place,region,country].filter(Boolean).join(", ")}: ${bits.join(" ")}`;
  }catch{return undefined;}
}

function isPublicUrl(raw:string):boolean{
  let u:URL;try{u=new URL(raw);}catch{return false;}
  if(u.protocol!=="https:")return false;
  const h=u.hostname.toLowerCase();
  if(h==="localhost"||h.endsWith(".local")||h==="127.0.0.1"||h==="::1"||h==="0.0.0.0")return false;
  if(/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)||/^169\.254\./.test(h))return false;
  return true;
}
function htmlToText(html:string):string{return html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<nav[\s\S]*?<\/nav>/gi,"").replace(/<footer[\s\S]*?<\/footer>/gi,"").replace(/<br\s*\/?>/gi,"\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi,"\n").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&nbsp;/g," ").replace(/\n{3,}/g,"\n\n");}
interface WebResult{title:string;url:string;snippet:string;}
function parseDuckDuckGo(html:string):WebResult[]{const results:WebResult[]=[];const linkRe=/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;const snippetRe=/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;const snippets:string[]=[];let sm:RegExpExecArray|null;while((sm=snippetRe.exec(html))!==null)snippets.push(stripHtml(sm[1]));let lm:RegExpExecArray|null;let i=0;while((lm=linkRe.exec(html))!==null){results.push({url:decodeDdgUrl(lm[1]),title:stripHtml(lm[2]),snippet:snippets[i++]??""});}return results;}
function stripHtml(s:string):string{return s.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();}
function decodeDdgUrl(href:string):string{const m=href.match(/[?&]uddg=([^&]+)/);if(m){try{return decodeURIComponent(m[1]);}catch{}}return href.startsWith("//")?`https:${href}`:href;}
