import { memo, useEffect, useMemo, useRef, useState } from "react";

/**
 * Tiny dependency-free markdown renderer. Handles fenced code blocks (with a
 * copy button), inline code, bold/italic, strikethrough, headings, lists, and
 * links — enough for chat replies without pulling a heavy parser in.
 *
 * IMPORTANT: the inline parser is a single-pass, indexOf-based scanner with NO
 * shared regex state and NO recursion, so it can never infinite-loop or
 * catastrophically backtrack no matter what the model emits.
 *
 * Memoized: MessageList re-renders on every streaming delta, and without memo
 * every historic bubble would re-parse its markdown per token.
 */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const prepared = streaming ? hideDanglingMarkers(text) : text;
  const blocks = useMemo(() => splitFences(prepared), [prepared]);
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <CodeBlock key={i} lang={b.lang} code={b.content} streaming={streaming === true && !b.closed} />
        ) : (
          <Prose key={i} text={b.content} />
        )
      )}
    </div>
  );
});

/**
 * While streaming, drop a single trailing unpaired inline marker so partial
 * tokens like "**bol" don't briefly render literal asterisks. Uses only
 * end-anchored linear replacements — no backtracking.
 */
function hideDanglingMarkers(text: string): string {
  const blocks = splitFences(text);
  const last = blocks[blocks.length - 1];
  if (last?.type === "code" && !last.closed) return text; // inside an open code block

  let out = text;
  if ((out.match(/`/g) || []).length % 2 === 1) out = out.replace(/`[^`\n]*$/, "");
  if ((out.match(/\*\*/g) || []).length % 2 === 1) out = out.replace(/\*\*[^*\n]*$/, "");
  return out;
}

export interface MarkdownBlock {
  type: "code" | "text";
  content: string;
  lang?: string;
  closed?: boolean;
}

/**
 * Line-oriented CommonMark fence scanner with resilience for:
 *  - Variable-length backtick/tilde fences (````, ~~~) so outer 4-backtick blocks preserve inner ``` fences
 *  - Unclosed/streaming code fences (renders live as a code block instead of spilling raw prose)
 *  - Legacy 3-backtick markdown/md blocks that embed inner ```lang ... ``` snippets
 */
export function splitFences(text: string): MarkdownBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  const textLines: string[] = [];

  let inFence = false;
  let fenceChar: "`" | "~" = "`";
  let fenceLen = 3;
  let fenceLang = "";
  let codeLines: string[] = [];
  let markdownNestedDepth = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    const chunk = textLines.join("\n");
    textLines.length = 0;
    if (chunk) blocks.push({ type: "text", content: chunk });
  };

  const countFenceStatsAfter = (fromIdx: number) => {
    let bare = 0;
    let tagged = 0;
    let hasMarkdown = false;
    for (let j = fromIdx; j < lines.length; j++) {
      const l = lines[j];
      if (/^ {0,3}`{3}\s*$/.test(l)) bare++;
      else {
        const tm = l.match(/^ {0,3}`{3}([^\s`].*)$/);
        if (tm) {
          tagged++;
          if (/^(?:markdown|md|mdx)(?:\s|$)/i.test(tm[1].trim())) hasMarkdown = true;
        }
      }
    }
    return { bare, tagged, hasMarkdown };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inFence) {
      const openMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const marker = openMatch[1];
        const char = marker[0] as "`" | "~";
        const info = openMatch[2] ?? "";
        // Per CommonMark, backtick fence info strings cannot contain backticks (avoids ```inline``` lines).
        if (!(char === "`" && info.includes("`"))) {
          flushText();
          inFence = true;
          fenceChar = char;
          fenceLen = marker.length;
          fenceLang = info.trim();
          codeLines = [];
          markdownNestedDepth = 0;
          continue;
        }
      }
      textLines.push(line);
      continue;
    }

    const isOuterMarkdown =
      fenceChar === "`" &&
      fenceLen === 3 &&
      /^(?:markdown|md|mdx)(?:\s|$)/i.test(fenceLang);

    // Handle inner ```lang code fences nested inside a legacy 3-backtick ```markdown block.
    if (isOuterMarkdown) {
      const innerOpen = line.match(/^ {0,3}`{3}([^\s`].*)$/);
      if (innerOpen) {
        const stats = countFenceStatsAfter(i + 1);
        if (stats.bare >= markdownNestedDepth + 2) {
          markdownNestedDepth++;
          codeLines.push(line);
          continue;
        }
      }
    }

    const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
      if (isOuterMarkdown && closeMatch[1].length === 3) {
        if (markdownNestedDepth > 0) {
          markdownNestedDepth--;
          codeLines.push(line);
          continue;
        }
        const stats = countFenceStatsAfter(i + 1);
        const unpairedBare = stats.bare - stats.tagged;
        if (!stats.hasMarkdown && unpairedBare >= 2 && unpairedBare % 2 === 0) {
          markdownNestedDepth++;
          codeLines.push(line);
          continue;
        }
      }
      blocks.push({
        type: "code",
        lang: fenceLang,
        content: codeLines.join("\n"),
        closed: true,
      });
      inFence = false;
      codeLines = [];
      markdownNestedDepth = 0;
      continue;
    }

    codeLines.push(line);
  }

  if (inFence) {
    // Drop trailing blank line emitted before EOF split if empty while closed handled above
    blocks.push({
      type: "code",
      lang: fenceLang,
      content: codeLines.join("\n"),
      closed: false,
    });
  } else {
    flushText();
  }

  return blocks;
}

export const CODE_PREVIEW_LINES = 14;
export const CODE_COLLAPSE_MIN_LINES = 20;
export const CODE_COLLAPSE_MIN_CHARS = 1400;

export interface CodeBlockPreview {
  isBig: boolean;
  lineCount: number;
  hiddenLines: number;
  previewText: string;
}

export function computeCodeBlockPreview(code: string): CodeBlockPreview {
  const lines = code.split("\n");
  const lineCount = lines.length;
  const isBig = lineCount > CODE_COLLAPSE_MIN_LINES || code.length > CODE_COLLAPSE_MIN_CHARS;
  if (!isBig) {
    return { isBig: false, lineCount, hiddenLines: 0, previewText: code };
  }
  if (lineCount > CODE_PREVIEW_LINES) {
    return {
      isBig: true,
      lineCount,
      hiddenLines: lineCount - CODE_PREVIEW_LINES,
      previewText: lines.slice(0, CODE_PREVIEW_LINES).join("\n"),
    };
  }
  return {
    isBig: true,
    lineCount,
    hiddenLines: 0,
    previewText: `${code.slice(0, CODE_COLLAPSE_MIN_CHARS)}…`,
  };
}

function CodeBlock({ lang, code, streaming }: { lang?: string; code: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const preview = useMemo(() => computeCodeBlockPreview(code), [code]);
  const isCollapsed = preview.isBig && !expanded;
  const displayedCode = isCollapsed ? preview.previewText : code;

  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    });
  };

  if (preview.isBig) {
    return (
      <div className={`code-block code-block-large${isCollapsed ? " collapsed" : ""}`}>
        <div className="code-block-header">
          <span className="code-block-meta">
            {lang ? lang.toUpperCase() : "TEXT"} · {preview.lineCount} lines{streaming ? " · streaming…" : ""}
          </span>
          <button
            type="button"
            className="code-block-copy"
            aria-label={copied ? "Copied code to clipboard" : "Copy full code to clipboard"}
            onClick={copy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="code-block-body">
          <pre>
            <code>{displayedCode}</code>
          </pre>
          {isCollapsed && <div className="code-block-fade" aria-hidden="true" />}
        </div>
        <button
          type="button"
          className="code-block-more-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {isCollapsed
            ? preview.hiddenLines > 0
              ? `See more (${preview.hiddenLines} more lines)`
              : "See more"
            : "Show less"}
        </button>
      </div>
    );
  }

  return (
    <div className="code-block">
      {lang && <span className="lang">{lang}</span>}
      <button
        type="button"
        className="copy-btn"
        aria-label={copied ? "Copied code to clipboard" : "Copy code to clipboard"}
        onClick={copy}
      >
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
