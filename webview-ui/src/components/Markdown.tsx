import { useEffect, useRef, useState } from "react";

/**
 * Tiny dependency-free markdown renderer. Handles fenced code blocks (with a
 * copy button), inline code, bold/italic, strikethrough, headings, lists, and
 * links — enough for chat replies without pulling a heavy parser in.
 *
 * IMPORTANT: the inline parser is a single-pass, indexOf-based scanner with NO
 * shared regex state and NO recursion, so it can never infinite-loop or
 * catastrophically backtrack no matter what the model emits.
 */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const prepared = streaming ? hideDanglingMarkers(text) : text;
  const blocks = splitFences(prepared);
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <CodeBlock key={i} lang={b.lang} code={b.content} />
        ) : (
          <Prose key={i} text={b.content} />
        )
      )}
    </div>
  );
}

/**
 * While streaming, drop a single trailing unpaired inline marker so partial
 * tokens like "**bol" don't briefly render literal asterisks. Uses only
 * end-anchored linear replacements — no backtracking.
 */
function hideDanglingMarkers(text: string): string {
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 === 1) return text; // inside an open code block

  let out = text;
  if ((out.match(/`/g) || []).length % 2 === 1) out = out.replace(/`[^`\n]*$/, "");
  if ((out.match(/\*\*/g) || []).length % 2 === 1) out = out.replace(/\*\*[^*\n]*$/, "");
  return out;
}

interface Block {
  type: "code" | "text";
  content: string;
  lang?: string;
}

function splitFences(text: string): Block[] {
  const blocks: Block[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) blocks.push({ type: "text", content: text.slice(last, m.index) });
    blocks.push({ type: "code", lang: m[1].trim(), content: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) blocks.push({ type: "text", content: text.slice(last) });
  return blocks;
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="code-block">
      {lang && <span className="lang">{lang}</span>}
      <button className="copy-btn" onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Prose({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: JSX.Element[] = [];
  let list: string[] | null = null;
  let ordered = false;

  const flush = () => {
    if (list) {
      const items = list.map((li, i) => <li key={i}>{inline(li)}</li>);
      out.push(ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (h) {
      flush();
      const Tag = `h${h[1].length}` as "h1" | "h2" | "h3";
      out.push(<Tag key={out.length}>{inline(h[2])}</Tag>);
    } else if (ul) {
      if (!list || ordered) flush();
      ordered = false;
      list = list ?? [];
      list.push(ul[1]);
    } else if (ol) {
      if (!list || !ordered) flush();
      ordered = true;
      list = list ?? [];
      list.push(ol[1]);
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      out.push(<p key={out.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{out}</>;
}

/**
 * Inline formatting via a single left-to-right scan. Every branch either
 * consumes a well-formed span (advancing past its closer) or falls through to
 * emit one literal character — so `i` strictly increases and the loop is O(n)
 * with a hard termination guarantee.
 */
function inline(text: string): (string | JSX.Element)[] {
  const nodes: (string | JSX.Element)[] = [];
  let buf = "";
  let key = 0;
  const n = text.length;
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = "";
    }
  };
  const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

  // Memoized closer search. Once a closer isn't found, it never will be again
  // (positions only advance), so we stop searching for it. This keeps the scan
  // O(n) even on unclosed markers like a lone "[" — without the memo, each such
  // position triggers a full-string indexOf scan → O(n²) and a UI freeze.
  const exhausted = new Set<string>();
  const find = (needle: string, from: number): number => {
    if (exhausted.has(needle)) return -1;
    const idx = text.indexOf(needle, from);
    if (idx === -1) exhausted.add(needle);
    return idx;
  };

  while (i < n) {
    const c = text[i];

    // inline code `...`
    if (c === "`") {
      const end = find("`", i + 1);
      if (end > i + 1) {
        flush();
        nodes.push(
          <code key={key++} className="inline">
            {text.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    // link [label](url)
    if (c === "[") {
      const close = find("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = find(")", close + 2);
        if (paren > close + 1) {
          const href = text.slice(close + 2, paren);
          // Only real web schemes become anchors — a model-emitted
          // javascript:/data: URL must never render as a clickable link.
          if (!/^https?:\/\//i.test(href)) {
            buf += text.slice(i, paren + 1);
            i = paren + 1;
            continue;
          }
          flush();
          nodes.push(
            <a key={key++} href={href} target="_blank" rel="noreferrer">
              {text.slice(i + 1, close)}
            </a>
          );
          i = paren + 1;
          continue;
        }
      }
    }

    // bold ** or __
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const marker = c + c;
      const end = find(marker, i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(<strong key={key++}>{text.slice(i + 2, end)}</strong>);
        i = end + marker.length;
        continue;
      }
    }

    // strikethrough ~~
    if (c === "~" && text[i + 1] === "~") {
      const end = find("~~", i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(<del key={key++}>{text.slice(i + 2, end)}</del>);
        i = end + 2;
        continue;
      }
    }

    // italic * or _ (opener not followed by space; avoid mid-word underscores)
    if ((c === "*" || c === "_") && !isSpace(text[i + 1])) {
      const prev = text[i - 1];
      const wordChar = c === "_" && prev !== undefined && /[A-Za-z0-9]/.test(prev);
      if (!wordChar) {
        const end = find(c, i + 1);
        if (end > i + 1 && !isSpace(text[end - 1])) {
          flush();
          nodes.push(<em key={key++}>{text.slice(i + 1, end)}</em>);
          i = end + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return nodes;
}
