import { clampToolResult, toolError, ok, type Tool } from "../types";

export const webSearchTool: Tool = {
  spec: {
    name: "web_search",
    summary: "Search the web for current or external information (docs, versions, prices, news). Returns URLs and snippets — then use web_fetch to read a page.",
    params: [{ name: "query", type: "string", required: true, description: "What to search for. Be specific and include keywords. Example: \"vite react plugin options\"." }],
    sideEffecting: false,
    priority: 13,
    minTier: "low",
    tags: ["web", "read", "search"],
    risk: "network",
    concurrency: "safe_parallel",
    idempotency: "idempotent",
    example: '```tool\nTOOL_NAME: web_search\nBEGIN_ARG: query\nvite react plugin options\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    if (ctx.webSearchProvider === "none") return toolError("permission_denied", "Web search is disabled in Photon settings.");
    const query = (args.query as string)?.trim();
    if (!query) return toolError("invalid_args", `Missing required argument "query". Provide a search query.`);
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]);
      const weather = extractWeatherLocation(query);
      if (weather) {
        const direct = await fetchCurrentWeather(weather, signal);
        if (direct) return ok(clampToolResult(direct));
      }
      const preferred = ctx.webSearchProvider === "google" ? "google" : "duckduckgo";
      let results: WebResult[] = [];
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
      const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };

      if (preferred === "google") {
        try {
          const res = await fetch(googleUrl, { method: "GET", signal, headers });
          if (res.ok) {
            const html = await res.text();
            results = parseGoogle(html);
          }
        } catch {}
      }

      // Fallback to DuckDuckGo if Google returned no results or if DDG was selected
      if (!results.length) {
        try {
          const res = await fetch(ddgUrl, { method: "GET", signal, headers });
          if (res.ok) {
            const html = await res.text();
            results = parseDuckDuckGo(html);
          }
        } catch {}
      }

      results = results.slice(0, ctx.capability === "max" ? 8 : 5);
      if (!results.length) return ok("No results found. Try different keywords.");
      const resultList = results.map((r,i)=>`${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return ok(clampToolResult(resultList));
    } catch(e) {
      if((e as Error).name==="AbortError")return toolError("execution_error","Search cancelled.");
      return toolError("execution_error",`Search error: ${(e as Error).message}`);
    }
  },
};

export const webFetchTool: Tool = {
  spec: {
    name: "web_fetch",
    summary: "Read a web page's text. Use this AFTER web_search to read the full content of a URL from the results.",
    params: [
      { name: "url", type: "string", required: true, description: "Public https:// URL to fetch. Copy it from web_search results. Example: \"https://example.com\"." },
    ],
    sideEffecting: false,
    priority: 14,
    minTier: "low",
    tags: ["web", "read"],
    risk: "network",
    concurrency: "safe_parallel",
    idempotency: "idempotent",
    example: '```tool\nTOOL_NAME: web_fetch\nBEGIN_ARG: url\nhttps://example.com\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const rawUrl = (args.url as string)?.trim();
    if (!rawUrl || !/^https:\/\//i.test(rawUrl)) return toolError("invalid_args","Only public HTTPS URLs are allowed.");
    if (!isPublicUrl(rawUrl)) return toolError("permission_denied","Blocked URL: Photon only fetches public HTTPS hosts, not localhost/private/link-local addresses.");
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]);
      const res = await fetchPublicHttps(rawUrl, { signal, headers: { "User-Agent": "Photon VS Code extension" } });
      if (!res.ok) return toolError("execution_error",`Request failed with status ${res.status}.`);
      const contentType = res.headers.get("content-type") ?? "";
      const body = (await res.text()).slice(0, 2_000_000);
      const text = /html/i.test(contentType) ? htmlToText(body) : body;
      const lines = text.split("\n").filter(l=>l.trim()!=="");
      // §4: Truncate to ~1200 tok
      return ok(clampToolResult(lines.join("\n")));
    } catch(e) {
      if((e as Error).name==="AbortError")return toolError("execution_error","Fetch cancelled.");
      return toolError("execution_error",`web_fetch error: ${(e as Error).message}`);
    }
  },
};

/** Fetch with manual redirect handling so each hop is re-checked against the SSRF guard. */
async function fetchPublicHttps(url: string, init: RequestInit, maxRedirects = 3): Promise<Response> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!isPublicUrl(current)) throw new Error("Blocked redirect to non-public address.");
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Request redirected (${res.status}) with no location.`);
      const next = new URL(loc, current).toString();
      if (!/^https:\/\//i.test(next)) throw new Error("Blocked redirect: HTTPS only.");
      await res.body?.cancel().catch(() => {});
      current = next;
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

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
  if(u.username||u.password)return false;
  let h=u.hostname.toLowerCase().replace(/\.$/,"");
  if(!h)return false;
  // Hostname blocklist: localhost variants + internal-only zones.
  if(h==="localhost"||h.endsWith(".localhost")||h.endsWith(".local")||h.endsWith(".internal")||h.endsWith(".invalid")||h.endsWith(".test"))return false;
  if(h==="127.0.0.1"||h==="::1"||h==="::"||h==="0.0.0.0")return false;
  // IPv6: loopback, unspecified, link-local, unique-local, multicast,
  // and IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4 too.
  const lower=h;
  if(lower.includes(":")){
    const v6=lower.replace(/^\[(.*)\]$/,"$1");
    if(v6==="::1"||v6==="::")return false;
    if(/^fe80:/i.test(v6)||/^fc00:|^fd00:/i.test(v6)||/^ff00:/i.test(v6))return false;
    const mapped=v6.match(/::ffff:([^:]+)$/i);
    if(mapped&&isBlockedIPv4(mapped[1]))return false;
    // Any other literal IPv6 that parses as an IP but isn't global — be
    // conservative only for well-known non-global ranges above; global IPv6
    // (e.g. a public website AAAA) is allowed.
    return true;
  }
  if(isBlockedIPv4(h))return false;
  // Legacy dotted forms are handled inside isBlockedIPv4 (decimal/hex/octal).
  if(/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)||/^169\.254\./.test(h))return false;
  return true;
}

/** True if the host is an IPv4 literal (decimal/octal/hex, 1-4 parts) in a non-public range. */
function isBlockedIPv4(host:string):boolean{
  const n=parseIPv4(host);
  if(n===null)return false; // not an IP literal — hostname rules apply
  const b=(shift:number)=>((n>>>shift)&0xff);
  // 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0.0/24,
  // 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4+, 240/4
  if(b(24)===0)return true;
  if(b(24)===10)return true;
  if(b(24)===127)return true;
  if(b(24)===169&&b(16)===254)return true;
  if(b(24)===172&&b(16)>=16&&b(16)<=31)return true;
  if(b(24)===192&&b(16)===168)return true;
  if(b(24)===192&&b(16)===0&&(b(8)===0||b(8)===2))return true;
  if(b(24)===198&&b(16)===18)return true;
  if(b(24)===198&&b(16)===51&&b(8)===100)return true;
  if(b(24)===203&&b(16)===113)return true;
  if(b(24)===100&&b(16)>=64&&b(16)<=127)return true;
  if(b(24)>=224)return true;
  return false;
}

/** Parse IPv4 literals including non-standard forms attackers use to bypass
 *  denylists: single decimal (2130706433), hex (0x7f.0.0.1), octal (0177.0.0.1),
 *  and 1-4 part dotted forms. Returns the 32-bit value or null if not an IP. */
function parseIPv4(host:string):number|null{
  if(!/^[0-9a-fxXoO.]+$/.test(host)||!/[0-9]/.test(host))return null;
  const parts=host.split(".");
  if(parts.length<1||parts.length>4)return null;
  const nums:number[]=[];
  for(const p of parts){
    if(!p)return null;
    let v:number;
    if(/^0x[0-9a-f]+$/i.test(p))v=parseInt(p,16);
    else if(/^0[0-9]+$/.test(p)&&/^[0-7]+$/.test(p.slice(1))||p==="0")v=parseInt(p,8);
    else if(/^\d+$/.test(p))v=parseInt(p,10);
    else if(/^[0-9a-f]+$/i.test(p)&&parts.length===1)v=parseInt(p,10);
    else return null;
    if(!Number.isFinite(v)||v<0)return null;
    nums.push(v);
  }
  // Single number = full 32-bit address (decimal or hex).
  if(nums.length===1){
    if(nums[0]>0xffffffff)return null;
    return nums[0]>>>0;
  }
  // Multi-part: last part may consume remaining bytes (inet_aton rules).
  // Recompute properly per inet_aton: a.b.c.d / a.b.c (c 16-bit) / a.b (b 24-bit).
  let n = 0;
  if(nums.length===4){for(const v of nums){if(v>255)return null;n=(n<<8)|v;}}
  else if(nums.length===3){const[a,b,c]=nums;if(a>255||b>255||c>65535)return null;n=(a<<24)|(b<<16)|c;}
  else if(nums.length===2){const[a,b]=nums;if(a>255||b>16777215)return null;n=(a<<24)|b;}
  return n>>>0;
}
function htmlToText(html:string):string{return html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<nav[\s\S]*?<\/nav>/gi,"").replace(/<footer[\s\S]*?<\/footer>/gi,"").replace(/<br\s*\/?>/gi,"\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi,"\n").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&nbsp;/g," ").replace(/\n{3,}/g,"\n\n");}
interface WebResult{title:string;url:string;snippet:string;}
function isAdUrl(url:string):boolean{
  return /duckduckgo\.com\/y\.js|ad_provider|bing\.com\/aclick|googleadservices/i.test(url);
}
function parseDuckDuckGo(html:string):WebResult[]{
  const results:WebResult[]=[];

  // Instant answer / zero-click abstract if available
  const zciRe=/<div[^>]*class="[^"]*zci__result[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
  const zm=zciRe.exec(html);
  if(zm){
    const abstract=stripHtml(zm[1]).trim();
    if(abstract.length>20){
      const headingMatch=html.match(/<h1[^>]*class="[^"]*zci__heading[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
      const title=headingMatch?stripHtml(headingMatch[1]).trim():"Instant Answer";
      const linkMatch=(headingMatch?.[0]??zm[0]).match(/href="([^"]+)"/i);
      const url=linkMatch?decodeDdgUrl(linkMatch[1]):"";
      if(url&&/^https:\/\//i.test(url)&&!isAdUrl(url)){
        results.push({title,url,snippet:abstract});
      }
    }
  }

  const linkRe=/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe=/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets:string[]=[];
  let sm:RegExpExecArray|null;
  while((sm=snippetRe.exec(html))!==null)snippets.push(stripHtml(sm[1]));
  let lm:RegExpExecArray|null;
  let i=0;
  while((lm=linkRe.exec(html))!==null){
    const url=decodeDdgUrl(lm[1]);
    const snippet=snippets[i++]??"";
    if(isAdUrl(url))continue;
    if(!/^https?:\/\//i.test(url))continue;
    results.push({url,title:stripHtml(lm[2]),snippet});
  }
  return results;
}
function parseGoogle(html:string):WebResult[]{
  const results:WebResult[]=[];
  // Google's HTML varies, but result links consistently appear as <a href="/url?q=..."> or <a href="https://...">
  // with an <h3> title inside. We extract h3 titles and their parent anchor hrefs.
  const h3Re=/<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let m:RegExpExecArray|null;
  while((m=h3Re.exec(html))!==null){
    const title=stripHtml(m[1]);
    if(!title || title.length < 3) continue;
    // Look backwards for the nearest <a href="..."> before this h3
    const before=html.slice(Math.max(0, m.index - 600), m.index);
    const hrefMatch=before.match(/<a[^>]*href="([^"]+)"[^>]*>\s*$/i) || before.match(/<a[^>]*href="([^"]+)"[^>]*>[^<]*$/i);
    let url=hrefMatch ? hrefMatch[1] : "";
    if(url.startsWith("/url?q=")){
      try{ url=decodeURIComponent(url.slice(7).split("&")[0]); }catch{}
    }
    if(!url || !/^https:\/\//i.test(url)) continue;
    if(url.includes("google.com") || url.includes("gstatic.com")) continue;
    // Snippet: text after h3, before next h3
    const after=html.slice(m.index + m[0].length, m.index + m[0].length + 800);
    const snippetMatch=after.match(/<span[^>]*>([\s\S]{20,300}?)<\/span>/i);
    const snippet=snippetMatch ? stripHtml(snippetMatch[1]).slice(0, 200) : "";
    results.push({ title, url, snippet });
    if(results.length >= 10) break;
  }
  // Fallback: if h3 parsing found nothing, try generic anchor extraction
  if(results.length === 0){
    const aRe=/<a[^>]*href="(\/url\?q=[^"]+|https:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let am:RegExpExecArray|null;
    while((am=aRe.exec(html))!==null){
      let url=am[1];
      if(url.startsWith("/url?q=")){ try{ url=decodeURIComponent(url.slice(7).split("&")[0]); }catch{} }
      if(!/^https:\/\//i.test(url) || url.includes("google.com")) continue;
      const title=stripHtml(am[2]).slice(0, 120);
      if(!title || title.length < 5) continue;
      results.push({ title, url, snippet: "" });
      if(results.length >= 8) break;
    }
  }
  return results;
}
function stripHtml(s:string):string{return s.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();}
function decodeDdgUrl(href:string):string{const m=href.match(/[?&]uddg=([^&]+)/);if(m){try{return decodeURIComponent(m[1]);}catch{}}return href.startsWith("//")?`https:${href}`:href;}
