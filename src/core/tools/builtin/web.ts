import { clamp, fail, ok, outputBudget, type Tool } from "../types";

/**
 * Minimal web search via DuckDuckGo's HTML endpoint (no API key). Parses the
 * result list with regex — good enough to give a local model a few leads.
 */
export const webSearchTool: Tool = {
  spec: {
    name: "web_search",
    summary: "Search the web and return the top results (title, url, snippet).",
    params: [
      { name: "query", type: "string", required: true, description: "What to search for." },
    ],
    sideEffecting: false,
    priority: 13,
    // Rarely needed for local coding tasks and adds noise; reserve for high tiers.
    minTier: "high",
    tags: ["web", "read"],
    example: '[TOOL web_search]\nquery: vite react plugin options 2026\n[/TOOL]',
  },
  async execute(args, ctx) {
    if (ctx.webSearchProvider === "none") {
      return fail("Web search is disabled in Photon settings.");
    }
    const query = (args.query as string)?.trim();
    if (!query) return fail("Provide a search query.");

    try {
      // Combine user-cancel with a hard timeout so a stalled endpoint can't hang.
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]);
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          method: "POST",
          signal,
          headers: { "User-Agent": "Mozilla/5.0 (Photon VS Code extension)" },
        }
      );
      if (!res.ok) return fail(`Search failed with status ${res.status}.`);
      const html = await res.text();
      const maxResults = ctx.capability === "max" ? 8 : 5;
      const results = parseDuckDuckGo(html).slice(0, maxResults);
      if (results.length === 0) return ok("No results found. Try different keywords.");
      const text = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
      return ok(clamp(text, outputBudget(ctx)));
    } catch (e) {
      if ((e as Error).name === "AbortError") return fail("Search cancelled.");
      return fail(`Web search error: ${(e as Error).message}`);
    }
  },
};

/** Fetch a URL and return readable text — docs pages, changelogs, raw files. */
export const webFetchTool: Tool = {
  spec: {
    name: "web_fetch",
    summary: "Fetch a web page or raw file by URL and return its readable text.",
    params: [
      { name: "url", type: "string", required: true, description: "Full http(s) URL to fetch." },
      { name: "start_line", type: "number", required: false, description: "First line of the extracted text to return (for paging through long pages)." },
    ],
    sideEffecting: false,
    priority: 14,
    minTier: "high",
    tags: ["web", "read"],
    example: '[TOOL web_fetch]\nurl: https://raw.githubusercontent.com/user/repo/main/README.md\n[/TOOL]',
  },
  async execute(args, ctx) {
    const url = (args.url as string)?.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return fail("Provide a full http(s) URL.");
    }
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]);
      const res = await fetch(url, {
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (Photon VS Code extension)" },
      });
      if (!res.ok) return fail(`Request failed with status ${res.status}. Check the URL.`);
      const contentType = res.headers.get("content-type") ?? "";
      const body = (await res.text()).slice(0, 2_000_000);
      const text = /html/i.test(contentType) ? htmlToText(body) : body;
      const lines = text.split("\n").filter((l) => l.trim() !== "");

      const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
      if (start > lines.length) return ok(`Page has ${lines.length} non-empty lines; start_line ${start} is past the end.`);
      const cap = 400;
      const slice = lines.slice(start - 1, start - 1 + cap);
      const note =
        start - 1 + cap < lines.length
          ? `\n… [${lines.length - (start - 1 + cap)} more lines. Call again with start_line: ${start + cap}]`
          : "";
      return ok(clamp(slice.join("\n") + note, outputBudget(ctx)));
    } catch (e) {
      if ((e as Error).name === "AbortError") return fail("Fetch cancelled.");
      return fail(`web_fetch error: ${(e as Error).message}`);
    }
  },
};

/** Crude but effective HTML → text: drop script/style, tags, collapse blanks. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGo(html: string): WebResult[] {
  const results: WebResult[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1]));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null) {
    results.push({
      url: decodeDdgUrl(lm[1]),
      title: stripHtml(lm[2]),
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return results;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function decodeDdgUrl(href: string): string {
  // DuckDuckGo wraps links as /l/?uddg=<encoded>.
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}
