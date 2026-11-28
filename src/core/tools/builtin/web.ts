import { fetch as undiciFetch } from "undici";
import { createPinnedDispatcher } from "../mcp/mcpClient";
import { validateRemoteEndpoint, type DnsLookupFn } from "../mcp/dnsValidator";
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
      const directCompleteHint =
        "\n\n[Live data retrieved directly. Do NOT call web_search or web_fetch again — answer the user's question now in plain text using the data above.]";
      const weather = extractWeatherLocation(query);
      if (weather) {
        const direct = await fetchCurrentWeather(weather, signal);
        if (direct) return ok(clampToolResult(direct + directCompleteHint));
      }
      const currency = extractCurrencyQuery(query);
      if (currency) {
        const direct = await fetchCurrencyExchangeRate(currency, signal);
        if (direct) return ok(clampToolResult(direct + directCompleteHint));
      }
      const preferred = ctx.webSearchProvider === "google" ? "google" : "duckduckgo";
      let results: WebResult[] = [];
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const ddgLiteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;

      if (preferred === "google") {
        try {
          const res = await fetch(googleUrl, { method: "GET", signal, headers: BROWSER_HEADERS });
          if (res.ok) {
            const html = await res.text();
            results = parseGoogle(html);
          }
        } catch {}
      }

      // Fallback to DuckDuckGo HTML if Google returned no results or if DDG was selected
      if (!results.length) {
        try {
          const res = await fetch(ddgUrl, { method: "GET", signal, headers: BROWSER_HEADERS });
          if (res.ok && res.status === 200) {
            const html = await res.text();
            results = parseDuckDuckGo(html);
          }
        } catch {}
      }

      // Fallback to DuckDuckGo Lite HTML if primary DDG HTML endpoint returned 202 or no results
      if (!results.length) {
        try {
          const res = await fetch(ddgLiteUrl, { method: "GET", signal, headers: BROWSER_HEADERS });
          if (res.ok && res.status === 200) {
            const html = await res.text();
            results = parseDuckDuckGoLite(html);
          }
        } catch {}
      }

      // Fallback to official JSON search APIs (DuckDuckGo Instant Answer + Wikipedia Extracts Search)
      // when HTML scraping returns no results (e.g. HTTP 202 / CSR pages).
      if (!results.length) {
        results = await fetchJsonSearchFallbacks(query, signal);
      }

      results = rankWebResultsForFetchability(results).slice(0, ctx.capability === "max" ? 8 : 5);
      if (!results.length) return ok("No results found. Try different keywords.");
      const resultList = results.map((r,i)=>`${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      const fetchFollowupHint =
        "\n\n[Next step: Search snippets are only short page previews. If the exact live value, price, quote, or detail requested by the user is not explicitly stated in the snippets above, you MUST call web_fetch on the best URL above right now to read the page content — NEVER tell the user to visit the links themselves without calling web_fetch first.]";
      return ok(clampToolResult(resultList + fetchFollowupHint));
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
      const res = await fetchPublicHttps(rawUrl, { signal, headers: BROWSER_HEADERS });
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

/** Fetch with DNS-pinned SSRF guard and manual redirect handling across every hop. */
export async function fetchPublicHttps(
  url: string,
  init: RequestInit,
  maxRedirects = 3,
  customLookup?: DnsLookupFn
): Promise<Response> {
  const dispatcher = createPinnedDispatcher(false, customLookup);
  try {
    let current = url;
    for (let i = 0; i <= maxRedirects; i++) {
      if (!isPublicUrl(current)) throw new Error("Blocked redirect to non-public address.");
      const endpoint = await validateRemoteEndpoint(current, false, customLookup);
      if (!endpoint.ok) throw new Error(endpoint.reason || "Blocked redirect to non-public address.");
      const res = (await undiciFetch(current, {
        ...(init as any),
        redirect: "manual",
        dispatcher,
      })) as unknown as Response;
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
  } finally {
    // Do NOT await dispatcher.close() here: undici Agent.close() waits for active
    // response body streams to finish draining, which deadlocks if awaited before
    // the caller receives `res` and reads `await res.text()`.
    void dispatcher.close().catch(() => {});
  }
}

export function extractWeatherLocation(query: string): string | undefined {
  const raw = query.trim();
  if (!raw) return undefined;

  // Must mention a weather-related term
  if (!/\b(?:weather|forecast|temperature|temp)\b/i.test(raw)) {
    return undefined;
  }

  // Exclude coding, technical, tutorial, or hardware queries
  if (
    /\b(?:cpu|gpu|llm|model|models|sampling|openai|ollama|anthropic|gemini|claude|code|coding|function|class|component|react|vue|angular|nextjs|node|nodejs|python|javascript|typescript|rust|golang|java|c\+\+|tutorial|github|repo|repository|npm|pip|package|library|api|sdk|endpoint|key|app|application|widget|clone|build|create|error|bug|fix|sensor|arduino|esp32|raspberry|boiling|melting|oven|body|fever|convert|conversion|formula)\b/i.test(
      raw
    )
  ) {
    return undefined;
  }

  const unquoted = raw.replace(/["'`]+/g, " ").replace(/\s+/g, " ").trim();

  const cleanCandidate = (candidate: string): string | undefined => {
    const c = candidate
      .replace(/\b(?:weather\.com|accuweather\.com|accuweather|timeanddate\.com|timeanddate|bbc|google|yahoo|msn|cnn|ndtv|imd)\b/gi, " ")
      .replace(
        /\b(?:right\s+now|right\s+away|today(?:'s)?|tonight(?:'s)?|tomorrow(?:'s)?|this\s+week|weekend|currently|current|live|real[- ]?time|local|latest|now|weather|forecast|temperature|temp|climate|conditions?|report|updates?|like|outside|please|202\d)\b/gi,
        " "
      )
      .replace(/^(?:in|of|for|at|near|around|the|a|an)\b[\s,.-]*/i, "")
      .replace(/[\s,.-]*\b(?:in|of|for|at|near|around|the|a|an)$/i, "")
      .replace(/^[?.!,;:\s-]+|[?.!,;:\s-]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!c || c.length < 2 || c.length > 60) return undefined;
    if (/^(?:what|where|when|how|is|are|was|were|tell|me|show|get|check|find|search|\s)+$/i.test(c)) {
      return undefined;
    }
    return c;
  };

  // 1. Explicit preposition form: "weather/forecast/temperature ... in/of/for/at <location>"
  const prepMatch = unquoted.match(
    /\b(?:weather|forecast|temperature|temp)\b[\s\S]*?\b(?:in|of|for|at|near|around)\s+(.+?)\s*$/i
  );
  if (prepMatch) {
    const loc = cleanCandidate(prepMatch[1]);
    if (loc) return loc;
  }

  // 2. Keyword search form: "<location> current weather", "weather <location>", "<location> temperature today", etc.
  const stripped = unquoted.replace(
    /^(?:what(?:'s|\s+is)\s+(?:the\s+)?|how(?:'s|\s+is)\s+(?:the\s+)?|tell\s+me\s+(?:the\s+)?|show\s+(?:me\s+)?(?:the\s+)?|get\s+(?:the\s+)?|check\s+(?:the\s+)?|search\s+(?:for\s+)?(?:the\s+)?|find\s+(?:the\s+)?)+/i,
    " "
  );
  return cleanCandidate(stripped);
}

async function fetchCurrentWeather(location: string, signal: AbortSignal): Promise<string | undefined> {
  const fromWttr = await fetchWttrWeather(location, signal);
  if (fromWttr) return fromWttr;
  return fetchOpenMeteoWeather(location, signal);
}

async function fetchWttrWeather(location: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const subSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, { signal: subSignal, headers: { "User-Agent": "Photon VS Code extension" } });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      current_condition?: Array<{
        temp_C?: string;
        FeelsLikeC?: string;
        humidity?: string;
        weatherDesc?: Array<{ value?: string }>;
        windspeedKmph?: string;
        uvIndex?: string;
      }>;
      nearest_area?: Array<{
        areaName?: Array<{ value?: string }>;
        region?: Array<{ value?: string }>;
        country?: Array<{ value?: string }>;
      }>;
    };
    const cur = json.current_condition?.[0];
    if (!cur) return undefined;
    const area = json.nearest_area?.[0];
    const place = area?.areaName?.[0]?.value ?? location;
    const region = area?.region?.[0]?.value;
    const country = area?.country?.[0]?.value;
    const bits = [
      `${cur.weatherDesc?.[0]?.value ?? "Current conditions"}.`,
      cur.temp_C ? `Temperature: ${cur.temp_C}°C.` : "",
      cur.FeelsLikeC ? `Feels like: ${cur.FeelsLikeC}°C.` : "",
      cur.humidity ? `Humidity: ${cur.humidity}%.` : "",
      cur.windspeedKmph ? `Wind: ${cur.windspeedKmph} km/h.` : "",
      cur.uvIndex ? `UV index: ${cur.uvIndex}.` : "",
    ].filter(Boolean);
    return `Current weather for ${[place, region, country].filter(Boolean).join(", ")}: ${bits.join(" ")}`;
  } catch {
    return undefined;
  }
}

function describeWmoCode(code: number | undefined): string {
  if (code === undefined) return "Current conditions";
  if (code === 0) return "Clear sky";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Current conditions";
}

async function fetchOpenMeteoWeather(location: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const subSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const candidates = [location];
    const primaryComma = location.split(",")[0]?.trim();
    if (primaryComma && primaryComma !== location) candidates.push(primaryComma);
    const firstWord = location.split(/[\s,]+/)[0]?.trim();
    if (firstWord && firstWord.length >= 2 && !candidates.includes(firstWord)) candidates.push(firstWord);

    let hit:
      | { latitude: number; longitude: number; name?: string; admin1?: string; country?: string }
      | undefined;
    for (const cand of candidates) {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cand)}&count=1&language=en&format=json`;
      const geoRes = await fetch(geoUrl, { signal: subSignal, headers: { "User-Agent": "Photon VS Code extension" } });
      if (!geoRes.ok) continue;
      const geoJson = (await geoRes.json()) as {
        results?: Array<{ latitude: number; longitude: number; name?: string; admin1?: string; country?: string }>;
      };
      if (geoJson.results?.[0]) {
        hit = geoJson.results[0];
        break;
      }
    }
    if (!hit) return undefined;

    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`;
    const wRes = await fetch(wUrl, { signal: subSignal, headers: { "User-Agent": "Photon VS Code extension" } });
    if (!wRes.ok) return undefined;
    const wJson = (await wRes.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
    };
    const cur = wJson.current;
    if (!cur || cur.temperature_2m === undefined) return undefined;
    const bits = [
      `${describeWmoCode(cur.weather_code)}.`,
      `Temperature: ${cur.temperature_2m}°C.`,
      cur.apparent_temperature !== undefined ? `Feels like: ${cur.apparent_temperature}°C.` : "",
      cur.relative_humidity_2m !== undefined ? `Humidity: ${cur.relative_humidity_2m}%.` : "",
      cur.wind_speed_10m !== undefined ? `Wind: ${cur.wind_speed_10m} km/h.` : "",
    ].filter(Boolean);
    const label = [hit.name ?? location, hit.admin1, hit.country].filter(Boolean).join(", ");
    return `Current weather for ${label}: ${bits.join(" ")}`;
  } catch {
    return undefined;
  }
}

async function fetchJsonSearchFallbacks(query: string, signal: AbortSignal): Promise<WebResult[]> {
  const results: WebResult[] = [];
  const subSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);

  // 1. DuckDuckGo official Instant Answer JSON API
  try {
    const ddgApiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(ddgApiUrl, { signal: subSignal, headers: { "User-Agent": "Photon VS Code extension" } });
    if (res.ok) {
      const data = (await res.json()) as {
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        Answer?: string;
        Definition?: string;
        DefinitionURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      if (data.Answer) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL || "https://duckduckgo.com/",
          snippet: stripHtml(data.Answer),
        });
      }
      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL,
          snippet: stripHtml(data.AbstractText),
        });
      } else if (data.Definition && data.DefinitionURL) {
        results.push({
          title: data.Heading || query,
          url: data.DefinitionURL,
          snippet: stripHtml(data.Definition),
        });
      }
      for (const topic of data.RelatedTopics ?? []) {
        if (topic.Text && topic.FirstURL && /^https:\/\//i.test(topic.FirstURL)) {
          results.push({
            title: topic.Text.split(" - ")[0]?.slice(0, 80) || "Related Result",
            url: topic.FirstURL,
            snippet: stripHtml(topic.Text),
          });
          if (results.length >= 5) break;
        }
      }
    }
  } catch {}

  // 2. Wikipedia official MediaWiki Search + TextExtracts JSON API
  if (results.length < 3) {
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=5&prop=extracts|info&exintro=1&explaintext=1&exchars=500&inprop=url&format=json&utf8=1`;
      const res = await fetch(wikiUrl, { signal: subSignal, headers: { "User-Agent": "PhotonVSCodeExtension/1.0" } });
      if (res.ok) {
        const data = (await res.json()) as {
          query?: {
            pages?: Record<
              string,
              { index?: number; title?: string; extract?: string; fullurl?: string }
            >;
            search?: Array<{ title?: string; snippet?: string }>;
          };
        };
        if (data.query?.pages) {
          const pages = Object.values(data.query.pages).sort(
            (a, b) => (a.index ?? 999) - (b.index ?? 999)
          );
          for (const page of pages) {
            if (!page.title) continue;
            const url =
              page.fullurl ||
              `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/\s+/g, "_"))}`;
            if (results.some((r) => r.url === url)) continue;
            results.push({
              title: `${page.title} - Wikipedia`,
              url,
              snippet: page.extract ? stripHtml(page.extract).replace(/\s+/g, " ").trim() : "",
            });
            if (results.length >= 6) break;
          }
        }
        for (const item of data.query?.search ?? []) {
          if (!item.title) continue;
          const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, "_"))}`;
          if (results.some((r) => r.url === url)) continue;
          results.push({
            title: `${item.title} - Wikipedia`,
            url,
            snippet: item.snippet ? stripHtml(item.snippet) : "",
          });
          if (results.length >= 6) break;
        }
      }
    } catch {}
  }

  return results;
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const UNAMBIGUOUS_CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD",
  "SGD", "NZD", "KRW", "AED", "SAR", "BRL", "MXN", "ZAR", "RUB", "SEK",
  "NOK", "DKK", "PLN", "THB", "MYR", "IDR", "VND", "PKR", "BDT", "LKR",
  "NPR", "TWD", "ILS", "CLP", "EGP", "NGN", "KES", "QAR", "KWD", "BHD",
  "OMR", "CZK", "HUF", "BGN", "ISK", "UAH", "KZT", "GHS", "TND",
]);

const AMBIGUOUS_CURRENCY_CODES = new Set([
  "TRY", "PHP", "PEN", "COP", "ARS", "RON", "MAD",
]);

const CURRENCY_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:us\s+dollars?|american\s+dollars?|u\.s\.\s+dollars?)\b/i, "USD"],
  [/\b(?:indian\s+rupees?|rupees?)\b/i, "INR"],
  [/\b(?:euros?)\b/i, "EUR"],
  [/\b(?:british\s+pounds?|pounds?\s+sterling|sterling)\b/i, "GBP"],
  [/\b(?:japanese\s+yen|yen)\b/i, "JPY"],
  [/\b(?:australian\s+dollars?)\b/i, "AUD"],
  [/\b(?:canadian\s+dollars?)\b/i, "CAD"],
  [/\b(?:singapore\s+dollars?)\b/i, "SGD"],
  [/\b(?:new\s+zealand\s+dollars?)\b/i, "NZD"],
  [/\b(?:hong\s+kong\s+dollars?)\b/i, "HKD"],
  [/\b(?:swiss\s+francs?)\b/i, "CHF"],
  [/\b(?:chinese\s+yuan|yuan|renminbi|rmb)\b/i, "CNY"],
  [/\b(?:uae\s+dirhams?|emirati\s+dirhams?|dirhams?)\b/i, "AED"],
  [/\b(?:saudi\s+riyals?|riyals?)\b/i, "SAR"],
  [/\b(?:south\s+korean\s+won|korean\s+won)\b/i, "KRW"],
  [/\b(?:russian\s+rubles?|rubles?)\b/i, "RUB"],
  [/\b(?:brazilian\s+reais|brazilian\s+real)\b/i, "BRL"],
  [/\b(?:mexican\s+pesos?)\b/i, "MXN"],
  [/\b(?:philippine\s+pesos?)\b/i, "PHP"],
  [/\b(?:south\s+african\s+rand)\b/i, "ZAR"],
  [/\b(?:turkish\s+liras?)\b/i, "TRY"],
  [/\b(?:thai\s+baht|baht)\b/i, "THB"],
  [/\b(?:malaysian\s+ringgits?|ringgits?)\b/i, "MYR"],
  [/\b(?:indonesian\s+rupiahs?|rupiahs?)\b/i, "IDR"],
  [/\b(?:vietnamese\s+dong)\b/i, "VND"],
  [/\b(?:pakistani\s+rupees?)\b/i, "PKR"],
  [/\b(?:bangladeshi\s+taka|taka)\b/i, "BDT"],
  [/\b(?:sri\s+lankan\s+rupees?)\b/i, "LKR"],
  [/\b(?:nepalese\s+rupees?)\b/i, "NPR"],
];

export interface CurrencyQuery {
  amount: number;
  from: string;
  to: string;
}

export function extractCurrencyQuery(query: string): CurrencyQuery | undefined {
  const raw = query.trim();
  if (!raw) return undefined;

  const hasCurrencyContext =
    /\b(?:exchange\s+rates?|conversion\s+rates?|convert|conversion|currency|currencies|forex|fx|worth\s+in|value\s+in)\b/i.test(
      raw
    ) || /\b[A-Z]{3}\s*\/\s*[A-Z]{3}\b/i.test(raw);

  // Normalize full currency names into their 3-letter ISO codes first
  let normalized = raw;
  for (const [re, code] of CURRENCY_NAME_PATTERNS) {
    normalized = normalized.replace(re, ` ${code} `);
  }
  if (hasCurrencyContext && !/\b(?:AUD|CAD|SGD|NZD|HKD|TWD)\b/i.test(normalized)) {
    normalized = normalized.replace(/\bdollars?\b/i, " USD ");
    normalized = normalized.replace(/\bpounds?\b/i, " GBP ");
  }

  const isValidCode = (code: string, strict: boolean): boolean => {
    const upper = code.toUpperCase();
    if (UNAMBIGUOUS_CURRENCY_CODES.has(upper)) return true;
    if (!strict && hasCurrencyContext && AMBIGUOUS_CURRENCY_CODES.has(upper)) return true;
    return false;
  };

  // Pattern 1: "<amount?> <FROM> ... (to|in|into|/|vs|per) <TO>" (handles "USD conversion rate to INR", "100 USD to INR", "USD/INR")
  const pairRe =
    /(?:(\d+(?:\.\d+)?)\s+)?\b([A-Za-z]{3})\b(?:\s+(?:conversion|exchange|rate|price|value|currency|today|current|live))*\s*(?:to|in|into|\/|vs\.?|per)\s*\b([A-Za-z]{3})\b/i;
  const pm = normalized.match(pairRe);
  if (pm) {
    const amount = pm[1] ? parseFloat(pm[1]) : 1;
    const from = pm[2].toUpperCase();
    const to = pm[3].toUpperCase();
    if (
      from !== to &&
      Number.isFinite(amount) &&
      amount > 0 &&
      isValidCode(from, false) &&
      isValidCode(to, false) &&
      (UNAMBIGUOUS_CURRENCY_CODES.has(from) || UNAMBIGUOUS_CURRENCY_CODES.has(to))
    ) {
      return { amount, from, to };
    }
  }

  return undefined;
}

async function fetchCurrencyExchangeRate(
  q: CurrencyQuery,
  signal: AbortSignal
): Promise<string | undefined> {
  const subSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  const { amount, from, to } = q;

  const formatOutput = (rate: number, dateStr: string, source: string): string => {
    const converted = amount * rate;
    const inverse = rate > 0 ? 1 / rate : 0;
    const rateFormatted = rate >= 1 ? rate.toFixed(4).replace(/\.?0+$/, "") : rate.toPrecision(4);
    const convertedFormatted = converted.toFixed(2);
    const inverseFormatted = inverse >= 1 ? inverse.toFixed(4).replace(/\.?0+$/, "") : inverse.toPrecision(4);
    const lines = [
      `Live exchange rate (${dateStr}, source: ${source}):`,
      `1 ${from} = ${rateFormatted} ${to}`,
      `1 ${to} = ${inverseFormatted} ${from}`,
    ];
    if (amount !== 1) {
      lines.push(`${amount} ${from} = ${convertedFormatted} ${to}`);
    }
    return lines.join("\n");
  };

  // 1. ExchangeRate-API Open Access (supports 160+ world currencies including USD, INR, AED, etc.)
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, {
      signal: subSignal,
      headers: { "User-Agent": "Photon VS Code extension" },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        result?: string;
        time_last_update_utc?: string;
        rates?: Record<string, number>;
      };
      const rate = data.rates?.[to];
      if (typeof rate === "number" && Number.isFinite(rate)) {
        const dateStr = data.time_last_update_utc
          ? data.time_last_update_utc.replace(/\s+\d{2}:\d{2}:\d{2}\s+.*$/, "")
          : "latest";
        return formatOutput(rate, dateStr, "ExchangeRate-API");
      }
    }
  } catch {}

  // 2. Frankfurter API (European Central Bank reference rates)
  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        signal: subSignal,
        headers: { "User-Agent": "Photon VS Code extension" },
      }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        date?: string;
        rates?: Record<string, number>;
      };
      const rate = data.rates?.[to];
      if (typeof rate === "number" && Number.isFinite(rate)) {
        return formatOutput(rate, data.date || "latest", "ECB / Frankfurter");
      }
    }
  } catch {}

  return undefined;
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
function htmlToText(html:string):string{
  const metaLines:string[]=[];
  const titleMatch=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if(titleMatch?.[1]){
    const cleanTitle=stripHtml(titleMatch[1]).replace(/\s+/g," ").trim();
    if(cleanTitle)metaLines.push(`Title: ${cleanTitle}`);
  }
  const seenMeta=new Set<string>();
  for(const m of html.matchAll(/<meta\b[^>]+>/gi)){
    const tag=m[0];
    if(/(?:name|property)=["'](?:description|og:description|twitter:description)["']/i.test(tag)){
      const content=tag.match(/content=["']([^"']+)["']/i)?.[1];
      if(content){
        const cleanMeta=stripHtml(content).replace(/\s+/g," ").trim();
        if(cleanMeta&&!seenMeta.has(cleanMeta)){
          seenMeta.add(cleanMeta);
          metaLines.push(`Summary: ${cleanMeta}`);
        }
      }
    }
  }
  const bodyText=html
    .replace(/<!--[\s\S]*?-->/g,"")
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<svg[\s\S]*?<\/svg>/gi,"")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi,"")
    .replace(/<nav[\s\S]*?<\/nav>/gi,"")
    .replace(/<header[\s\S]*?<\/header>/gi,"")
    .replace(/<footer[\s\S]*?<\/footer>/gi,"")
    .replace(/<aside[\s\S]*?<\/aside>/gi,"")
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi,"\n")
    .replace(/<[^>]+>/g," ")
    .replace(/&amp;/g,"&")
    .replace(/&quot;/g,'"')
    .replace(/&#x27;|&#39;/g,"'")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&nbsp;/g," ")
    .split("\n")
    .map(l=>l.replace(/\s+/g," ").trim())
    .filter(Boolean)
    .join("\n");
  return metaLines.length?`${metaLines.join("\n")}\n\n${bodyText}`:bodyText;
}
interface WebResult{title:string;url:string;snippet:string;}
/**
 * Rank search results so server-rendered data pages (which yield rich text via web_fetch)
 * appear ahead of pure client-side JS canvas / SPA shells that return empty templates to static fetch.
 */
export function rankWebResultsForFetchability(results:WebResult[]):WebResult[]{
  const scoreUrl=(r:WebResult):number=>{
    const u=r.url.toLowerCase();
    // Deprioritize known client-only SPA/canvas shells that omit live numbers from static HTML
    if(/nseindia\.com|nseindia\.in\/(?:market-data|static)|tradingview\.com\/symbols|groww\.in\/indices/.test(u))return -10;
    // Boost server-rendered financial/factual pages & encyclopedias or snippets already containing numbers
    let s=0;
    if(/moneycontrol\.com|niftytrader\.in|wikipedia\.org|reuters\.com|cnbc\.com|investing\.com|marketwatch\.com|livemint\.com|economictimes/.test(u))s+=10;
    if(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(r.snippet))s+=8;
    return s;
  };
  return [...results]
    .map((r,idx)=>({r,idx,score:scoreUrl(r)}))
    .sort((a,b)=>b.score-a.score||a.idx-b.idx)
    .map(x=>x.r);
}
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
export function parseDuckDuckGoLite(html:string):WebResult[]{
  const results:WebResult[]=[];
  const linkRe=/<a\b[^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe=/<td\b[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets:string[]=[];
  let sm:RegExpExecArray|null;
  while((sm=snippetRe.exec(html))!==null)snippets.push(stripHtml(sm[1]).replace(/\s+/g," ").trim());
  let lm:RegExpExecArray|null;
  let i=0;
  while((lm=linkRe.exec(html))!==null){
    const hrefMatch=lm[0].match(/\bhref=['"]([^'"]+)['"]/i);
    if(!hrefMatch)continue;
    const url=decodeDdgUrl(hrefMatch[1]);
    const snippet=snippets[i++]??"";
    if(isAdUrl(url))continue;
    if(!/^https?:\/\//i.test(url))continue;
    results.push({url,title:stripHtml(lm[1]).replace(/\s+/g," ").trim(),snippet});
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
function decodeDdgUrl(href:string):string{const clean=href.replace(/&amp;/g,"&");const m=clean.match(/[?&]uddg=([^&]+)/);if(m){try{return decodeURIComponent(m[1]);}catch{}}return clean.startsWith("//")?`https:${clean}`:clean;}
