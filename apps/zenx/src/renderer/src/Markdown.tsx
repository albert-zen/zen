import { Children, isValidElement, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { classifyZenXLink } from "../../external-link-policy.js";

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "code"; language: string; text: string; closed: boolean };

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  const streaming = blocks.at(-1);
  const streamingBlock =
    streaming?.type === "code" && !streaming.closed ? streaming : null;
  const streamingFence =
    streamingBlock === null ? null : findUnclosedFence(text);

  if (streamingFence !== null && streamingBlock !== null) {
    return (
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
          urlTransform={(url) => url}
        >
          {prepareMarkdown(streamingFence.prefix)}
        </ReactMarkdown>
        <CodeBlock block={streamingBlock} />
      </div>
    );
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={(url) => url}
      >
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  a({ href, children }) {
    const target = classifyZenXLink(href ?? "");
    if (target.kind === "rejected") return <>{children}</>;
    if (target.kind === "anchor") return <a href={target.href}>{children}</a>;
    return (
      <a href={target.href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
  pre({ children }) {
    const child = Children.only(children);
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: unknown };
      const language = props.className?.match(/language-(\S+)/u)?.[1] ?? "";
      return (
        <CodeBlock
          block={{
            type: "code",
            language,
            text: String(props.children ?? "").replace(/\n$/u, ""),
            closed: true,
          }}
        />
      );
    }
    return <pre>{children}</pre>;
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^ ]*)?.*$/u.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const language = fence[2] ?? "";
      const body: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (
          new RegExp(
            `^ {0,3}${escapeRegExp(marker[0] ?? "`")}{${marker.length},}\\s*$`,
            "u",
          ).test(candidate)
        ) {
          closed = true;
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      blocks.push({ type: "code", language, text: body.join("\n"), closed });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      blocks.push({
        type: "heading",
        depth: heading[1]?.length ?? 1,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }
    if (/^ {0,3}>/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^ {0,3}>/u.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^ {0,3}> ?/u, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }
    const listMatch = /^\s*([-+*]|\d+[.)])\s+(.+)$/u.exec(line);
    if (listMatch !== null) {
      const ordered = /^\d/u.test(listMatch[1] ?? "");
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*([-+*]|\d+[.)])\s+(.+)$/u.exec(lines[index] ?? "");
        if (item === null || /^\d/u.test(item[1] ?? "") !== ordered) break;
        items.push(item[2] ?? "");
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1] ?? "")
    ) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        const cells = splitTableRow(lines[index] ?? "");
        if (cells.length === 0) break;
        rows.push(cells);
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function CodeBlock({
  block,
}: {
  block: Extract<MarkdownBlock, { type: "code" }>;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(block.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className={`markdown-code${block.closed ? "" : " streaming"}`}>
      <div className="markdown-code-header">
        <span>{block.language || "text"}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{block.text}</code>
      </pre>
    </div>
  );
}

function findUnclosedFence(source: string): {
  prefix: string;
} | null {
  const opening = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*$/gmu;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source)) !== null) last = match;
  if (last === null) return null;
  const openingIndex = last.index + (last[1]?.length ?? 0);
  return { prefix: source.slice(0, openingIndex) };
}

function prepareMarkdown(source: string): string {
  let inFence = false;
  return source
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(
        /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu,
        (match, label: string, href: string) =>
          classifyZenXLink(href).kind === "rejected" ? label : match,
      );
    })
    .join("\n");
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (line.trim().length === 0) return true;
  if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) return true;
  if (/^(#{1,6})\s+/u.test(line) || /^ {0,3}>/u.test(line)) return true;
  if (/^\s*([-+*]|\d+[.)])\s+/u.test(line)) return true;
  return line.includes("|") && isTableDivider(lines[index + 1] ?? "");
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
