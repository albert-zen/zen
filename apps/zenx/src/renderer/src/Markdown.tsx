import { Fragment, useState, type ReactNode } from "react";
import { classifyZenXLink } from "../../external-link-policy.js";

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "code"; language: string; text: string; closed: boolean };

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      {parseMarkdown(text).map((block, index) => (
        <MarkdownBlockView block={block} key={`${block.type}-${index}`} />
      ))}
    </div>
  );
}

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

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  if (block.type === "heading") {
    const Heading = `h${block.depth}` as
      "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Heading>{inlineMarkdown(block.text)}</Heading>;
  }
  if (block.type === "quote") {
    return <blockquote>{inlineMarkdown(block.text)}</blockquote>;
  }
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List>
        {block.items.map((item, index) => (
          <li key={index}>{inlineMarkdown(item)}</li>
        ))}
      </List>
    );
  }
  if (block.type === "table") {
    return (
      <div className="markdown-table-wrap">
        <table>
          <thead>
            <tr>
              {block.header.map((cell, index) => (
                <th key={index}>{inlineMarkdown(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.header.map((_header, cellIndex) => (
                  <td key={cellIndex}>
                    {inlineMarkdown(row[cellIndex] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "code") return <CodeBlock block={block} />;
  return <p>{inlineMarkdown(block.text)}</p>;
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

function inlineMarkdown(text: string): ReactNode[] {
  const output: ReactNode[] = [];
  const token = /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index));
    if (match[2] !== undefined) {
      output.push(<code key={`code-${match.index}`}>{match[2]}</code>);
    } else {
      const label = match[3] ?? "";
      const target = classifyZenXLink(match[4] ?? "");
      output.push(
        target.kind === "rejected" ? (
          <Fragment key={`link-${match.index}`}>{label}</Fragment>
        ) : target.kind === "anchor" ? (
          <a href={target.href} key={`link-${match.index}`}>
            {label}
          </a>
        ) : (
          <a
            href={target.href}
            key={`link-${match.index}`}
            rel="noreferrer"
            target="_blank"
          >
            {label}
          </a>
        ),
      );
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
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
