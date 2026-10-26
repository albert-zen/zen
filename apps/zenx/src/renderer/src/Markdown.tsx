import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import type { Parent, Root } from "mdast";
import type {
  Root as HtmlRoot,
  Element as HtmlElement,
  Text as HtmlText,
  RootContent,
} from "hast";
import { isLocalPath, remarkLocalPaths } from "./local-path-links.js";
import { MarkdownImage } from "./MarkdownImage.js";
import { classifyImageSource } from "../../image-source.js";
import { classifyMessageLink } from "../../external-link-policy.js";

export const MessageLinkContext = createContext<
  ((target: { kind: "file" | "browser"; value: string }) => void) | null
>(null);

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "code"; language: string; text: string; closed: boolean };

export interface MarkdownInlineToken {
  marker: string;
  node: ReactNode;
  copyText: string;
}
export function Markdown({
  text,
  inlineTokens = [],
}: {
  text: string;
  inlineTokens?: readonly MarkdownInlineToken[];
}) {
  useTranslation("panels");
  const onOpen = useContext(MessageLinkContext);
  const renderText = (value: string): ReactNode => {
    if (!inlineTokens.length) return value;
    const output: ReactNode[] = [];
    let tail = value;
    while (tail) {
      const next = inlineTokens
        .map((token, index) => ({
          token,
          index,
          at: tail.indexOf(token.marker),
        }))
        .filter((entry) => entry.at >= 0)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) {
        output.push(tail);
        break;
      }
      output.push(
        tail.slice(0, next.at),
        <span key={output.length}>{next.token.node}</span>,
      );
      tail = tail.slice(next.at + next.token.marker.length);
    }
    return output;
  };
  const copyText = (value: string) =>
    inlineTokens.reduce(
      (out, token) => out.split(token.marker).join(token.copyText),
      value,
    );
  const localPathPlugins: PluggableList = onOpen
    ? [
        [
          remarkLocalPaths,
          { markers: inlineTokens.map((token) => token.marker) },
        ],
      ]
    : [];
  const components: Components = {
    ...markdownComponents,
    a: messageAnchor(onOpen),
    pre: ({ children, node }) => {
      const child = Children.only(children);
      if (isValidElement(child)) {
        const props = child.props as {
          className?: string;
          children?: unknown;
        };
        const language = props.className?.match(/language-(\S+)/u)?.[1] ?? "";
        return (
          <CodeBlock
            block={{
              type: "code",
              language,
              text: String(props.children ?? "").replace(/\n$/u, ""),
              closed: true,
            }}
            renderText={renderText}
            copyText={copyText}
            filePathAllowed={
              closedTopLevelFence(text, node) &&
              !inlineTokens.some((token) =>
                String(props.children ?? "").includes(token.marker),
              )
            }
          />
        );
      }
      return <pre>{children}</pre>;
    },
    ...(inlineTokens.length
      ? ({
          span: ({ node, children }) => {
            const index = node?.properties?.dataZenxReference;
            return typeof index === "number" && inlineTokens[index] ? (
              <>{inlineTokens[index]!.node}</>
            ) : (
              <span>{children}</span>
            );
          },
          code: ({ children, className }) => (
            <code className={className}>
              {typeof children === "string" ? renderText(children) : children}
            </code>
          ),
        } satisfies Components)
      : {}),
  };
  // A reference inside hidden Markdown syntax must remain visible and must not
  // become a URL, image attribute, or an interactive control inside a link.
  // Render only that construct literally; the normal token pass still replaces
  // its marker at the exact source position.
  const referenceSyntaxPlugin =
    () => (tree: Root, file: { value: unknown }) => {
      const source = String(file.value);
      const hasMarker = (value: unknown) =>
        typeof value === "string" &&
        inlineTokens.some((token) => value.includes(token.marker));
      const visit = (parent: Parent) => {
        parent.children = parent.children.map((node) => {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          const raw =
            start !== undefined && end !== undefined
              ? source.slice(start, end)
              : "";
          const hiddenSyntax =
            [
              "link",
              "linkReference",
              "image",
              "imageReference",
              "definition",
              "html",
            ].includes(node.type) && hasMarker(raw);
          const codeMetadata =
            node.type === "code" &&
            (hasMarker(node.lang) || hasMarker(node.meta));
          if (hiddenSyntax || codeMetadata) {
            const text = { type: "text" as const, value: raw };
            return ["definition", "html", "code"].includes(node.type) &&
              ["root", "blockquote", "listItem"].includes(parent.type)
              ? { type: "paragraph" as const, children: [text] }
              : text;
          }
          if ("children" in node) visit(node as Parent);
          return node;
        }) as Parent["children"];
      };
      visit(tree);
    };
  const inlinePlugin = () => (tree: HtmlRoot) => {
    const visit = (parent: HtmlRoot | HtmlElement) => {
      if (parent.type === "element" && parent.tagName === "code") return;
      parent.children = (parent.children as RootContent[]).flatMap<RootContent>(
        (child) => {
          if (child.type === "element") {
            visit(child);
            return [child];
          }
          if (child.type !== "text") return [child];
          const pieces: (HtmlText | HtmlElement)[] = [];
          let tail = child.value;
          while (tail) {
            const next = inlineTokens
              .map((token, index) => ({
                token,
                index,
                at: tail.indexOf(token.marker),
              }))
              .filter((entry) => entry.at >= 0)
              .sort((a, b) => a.at - b.at)[0];
            if (!next) {
              pieces.push({ type: "text", value: tail });
              break;
            }
            if (next.at)
              pieces.push({ type: "text", value: tail.slice(0, next.at) });
            pieces.push({
              type: "element",
              tagName: "span",
              properties: { dataZenxReference: next.index },
              children: [],
            });
            tail = tail.slice(next.at + next.token.marker.length);
          }
          return pieces;
        },
      ) as typeof parent.children;
    };
    visit(tree);
  };
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
          remarkPlugins={[
            remarkGfm,
            remarkBareAutolinkResidue,
            ...localPathPlugins,
            ...(inlineTokens.length ? [referenceSyntaxPlugin] : []),
          ]}
          components={components}
          rehypePlugins={inlineTokens.length ? [inlinePlugin] : []}
          urlTransform={safeUrlTransform}
        >
          {prepareMarkdown(streamingFence.prefix)}
        </ReactMarkdown>
        <CodeBlock
          block={streamingBlock}
          renderText={renderText}
          copyText={copyText}
        />
      </div>
    );
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkBareAutolinkResidue,
          ...localPathPlugins,
          ...(inlineTokens.length ? [referenceSyntaxPlugin] : []),
        ]}
        components={components}
        rehypePlugins={inlineTokens.length ? [inlinePlugin] : []}
        urlTransform={safeUrlTransform}
      >
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  a: messageAnchor(null),
  img({ src, alt }) {
    return (
      <MarkdownImage
        key={typeof src === "string" ? src : ""}
        source={typeof src === "string" ? src : ""}
        name={alt ?? ""}
      />
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

function messageAnchor(
  onOpen: React.ContextType<typeof MessageLinkContext>,
): NonNullable<Components["a"]> {
  return ({ href, children, node }) => {
    if (
      node?.children.some(
        (child) => child.type === "element" && child.tagName === "img",
      )
    )
      return <span>{children}</span>;
    const target = classifyMessageLink(href ?? "");
    if (target.kind === "rejected") return <>{children}</>;
    if (target.kind === "anchor") return <a href={target.href}>{children}</a>;
    if (target.kind === "file" || target.kind === "browser") {
      if (!onOpen)
        return target.kind === "file" ? (
          <>{children}</>
        ) : (
          <a href={target.value} rel="noreferrer" target="_blank">
            {children}
          </a>
        );
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            onOpen(target);
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <a href={target.href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  };
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

// Only a source-confirmed, top-level closed fence may expose a file action.
// ReactMarkdown also renders unfinished nested fences; their existence is not
// evidence that the model has finished emitting the path.
function closedTopLevelFence(
  source: string,
  node: HtmlElement | undefined,
): boolean {
  const start = node?.position?.start.line;
  const end = node?.position?.end.line;
  if (!start || !end || end <= start) return false;
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const opening = /^ {0,3}(`{3,}|~{3,})(?:text|plaintext)\s*$/iu.exec(
    lines[start - 1] ?? "",
  );
  if (!opening) return false;
  const marker = opening[1]!;
  return new RegExp(
    `^ {0,3}${escapeRegExp(marker[0]!)}{${marker.length},}\\s*$`,
    "u",
  ).test(lines[end - 1] ?? "");
}

function CodeBlock({
  block,
  renderText = (value) => value,
  copyText = (value) => value,
  filePathAllowed = false,
}: {
  block: Extract<MarkdownBlock, { type: "code" }>;
  renderText?(value: string): ReactNode;
  copyText?(value: string): string;
  filePathAllowed?: boolean;
}) {
  useTranslation("panels");
  const onOpen = useContext(MessageLinkContext);
  // A separate explicit action, never syntax highlighting/linkification of code.
  // Keep whitespace and command-like payloads inert rather than guessing intent.
  const fileTarget =
    onOpen &&
    filePathAllowed &&
    block.closed &&
    /^(?:text|plaintext)$/iu.test(block.language) &&
    !/[\s;&|<>`$]/u.test(block.text) &&
    isLocalPath(block.text)
      ? classifyMessageLink(
          /^file:\/\//iu.test(block.text)
            ? new URL(block.text).toString()
            : encodeURI(block.text),
        )
      : null;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(copyText(block.text));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className={`markdown-code${block.closed ? "" : " streaming"}`}>
      <div className="markdown-code-header">
        <span>{block.language || "text"}</span>
        <span className="markdown-code-actions">
          {fileTarget?.kind === "file" && (
            <button type="button" onClick={() => onOpen?.(fileTarget)}>
              {i18n.t("panels:openMessageFile")}
            </button>
          )}
          <button type="button" onClick={() => void copy()}>
            {copied ? i18n.t("panels:copied") : i18n.t("panels:copy")}
          </button>
        </span>
      </div>
      <pre>
        <code>{renderText(block.text)}</code>
      </pre>
    </div>
  );
}

function findUnclosedFence(source: string): {
  prefix: string;
} | null {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  let opening: { index: number; character: string; length: number } | null =
    null;
  let offset = 0;
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(?:\s*[^ ]*)?.*$/u.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      if (opening === null) {
        opening = {
          index: offset,
          character: marker[0] ?? "`",
          length: marker.length,
        };
      } else if (
        new RegExp(
          `^ {0,3}${escapeRegExp(opening.character)}{${opening.length},}\\s*$`,
          "u",
        ).test(line)
      ) {
        opening = null;
      }
    }
    offset += line.length + 1;
  }
  return opening === null
    ? null
    : { prefix: normalized.slice(0, opening.index) };
}

// Only GFM's bare web links have a source span beginning with the URL itself.
// Explicit links, references and <autolinks> keep their authored destinations.
function remarkBareAutolinkResidue() {
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    function visit(parent: Parent) {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index]!;
        if (child.type !== "link") {
          if ("children" in child) visit(child);
          continue;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        const raw = source.slice(start, end);
        if (
          !/^(?:https?:\/\/|www\.)/iu.test(raw) ||
          child.children.length !== 1 ||
          child.children[0]?.type !== "text" ||
          child.children[0].value !== raw
        )
          continue;
        const prefix = trimBareAutolinkResidue(raw);
        if (prefix.length === raw.length) continue;
        child.url = /^www\./iu.test(raw) ? `http://${prefix}` : prefix;
        child.children = [{ type: "text", value: prefix }];
        parent.children.splice(index + 1, 0, {
          type: "text",
          value: raw.slice(prefix.length),
        });
        index += 1;
      }
    }
    visit(tree);
  };
}

function trimBareAutolinkResidue(raw: string): string {
  const punctuation =
    /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
  // Locate literal punctuation or individual escaped UTF-8 characters in the
  // original source. Never decode/re-encode a target or map decoded offsets:
  // adjacent escaped CJK, %2F and surrogate pairs must retain their exact bytes.
  const candidates =
    /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]|%(?:e3|ef)(?:%[89ab][0-9a-f]){2}/giu;
  let end = raw.length;
  for (const match of raw.matchAll(candidates)) {
    if (punctuation.test(decodeURIComponent(match[0]))) {
      end = match.index;
      break;
    }
  }
  return raw.slice(0, end).replace(/[*~`_'",.;:!?]+$/u, "");
}

function safeUrlTransform(url: string, key: string): string {
  if (key === "src")
    return classifyImageSource(url).kind === "rejected" ? "" : url;
  const target = classifyMessageLink(url);
  return target.kind === "rejected"
    ? ""
    : target.kind === "file"
      ? url // Keep the encoded spelling: messageAnchor classifies/decodes it once on click.
      : target.kind === "browser"
        ? target.value
        : target.href;
}

function prepareMarkdown(source: string): string {
  let opening: { character: string; length: number } | null = null;
  return source
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})(?:\s*[^ ]*)?.*$/u.exec(line);
      if (fence !== null) {
        const marker = fence[1] ?? "```";
        if (opening === null) {
          opening = { character: marker[0] ?? "`", length: marker.length };
        } else if (
          new RegExp(
            `^ {0,3}${escapeRegExp(opening.character)}{${opening.length},}\\s*$`,
            "u",
          ).test(line)
        ) {
          opening = null;
        }
        return line;
      }
      if (opening !== null) return line;
      return line.replace(
        /(?<!!)\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu,
        (match, label: string, href: string) =>
          classifyMessageLink(href).kind === "rejected" ? label : match,
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
