import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ComposerShell,
  ComposerEditor,
} from "../../src/renderer/src/Composer.js";
import { Icon, type IconName } from "../../src/renderer/src/icons.js";
import { Markdown } from "../../src/renderer/src/Markdown.js";
import { referenceMessage } from "../../src/renderer/src/reference-draft.js";
import type { Reference } from "../../src/renderer/src/composer-selector.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import bundle from "../../docs/reference-context/current/fixture-bundle.json";
import chatRequest from "../../docs/reference-context/current/chat-completions.request.pretty.json";
import responsesRequest from "../../docs/reference-context/current/responses.request.pretty.json";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "./quote-layout-comparison.css";
Object.assign(globalThis, { React });
void i18n.changeLanguage("zh-CN");
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const references = bundle.references as Reference[];
const categories = [
  "thread",
  "message",
  "subagent",
  "selection",
  "file",
] as const;
type Category = (typeof categories)[number];
const labels: Record<Category, string> = {
  thread: "线程",
  message: "消息",
  subagent: "子线程",
  selection: "选段",
  file: "文件",
};
const icons: Record<Category, IconName> = {
  thread: "thread",
  message: "conversation",
  subagent: "thread",
  selection: "quote",
  file: "file",
};
function tokenLabel(reference: Reference, category: Category) {
  if (category === "message") return "引用需要保留来源";
  if (category === "selection" && reference.kind === "message")
    return reference.excerpt;
  return reference.name;
}
/** Fixture-only common presentation. It does not add a parser or a new picker. */
function ReferenceToken({
  index,
  draft,
  onRemove,
  onInspect,
}: {
  index: number;
  draft: boolean;
  onRemove(): void;
  onInspect(index: number): void;
}) {
  const reference = references[index]!;
  const category = categories[index]!;
  return (
    <span
      className="reference-token"
      data-reference-category={category}
      data-delivery={
        reference.kind === "message" ? "included-excerpt" : "pointer"
      }
    >
      <button
        type="button"
        className="reference-token-details"
        aria-label={`查看${labels[category]}引用详情：${reference.name}`}
        onClick={() => onInspect(index)}
        title={`${labels[category]} · ${reference.kind === "message" ? "已包含原文" : "仅位置指针"}`}
      >
        <Icon name={icons[category]} size={13} />
        <span>{tokenLabel(reference, category)}</span>
      </button>
      {draft && (
        <button
          type="button"
          className="reference-token-remove"
          aria-label={`移除${labels[category]}引用`}
          onClick={onRemove}
        >
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  );
}
function Variant({
  layout,
  onInspect,
}: {
  layout: "external" | "inline";
  onInspect(index: number): void;
}) {
  const [removed, setRemoved] = useState<number[]>([]);
  const tokens = (draft: boolean) =>
    categories.map((_category, index) =>
      draft && removed.includes(index) ? null : (
        <ReferenceToken
          key={index}
          index={index}
          draft={draft}
          onInspect={onInspect}
          onRemove={() => setRemoved((v) => [...v, index])}
        />
      ),
    );
  const inline = (draft: boolean) => (
    <div className="inline-sequence">
      <span>请结合这些引用</span>
      {tokens(draft)}
      <span>说明实现边界，不要把指针当作已经读过的内容。</span>
    </div>
  );
  return (
    <section className={`layout-option layout-${layout}`} data-layout={layout}>
      <header className="option-heading">
        <span className="option-letter">
          {layout === "external" ? "A" : "B"}
        </span>
        <div>
          <h2>{layout === "external" ? "统一放在气泡外" : "统一排进正文流"}</h2>
          <p>
            {layout === "external"
              ? "所有引用都是附加上下文，正文只写问题。"
              : "所有引用都是正文中的对象，随文字一起换行。"}
          </p>
        </div>
      </header>
      <div className="layout-stage draft-stage">
        <div className="stage-label">
          草稿<span>五类引用 · 一套操作</span>
        </div>
        {layout === "external" && (
          <div className="adjunct-rail">{tokens(true)}</div>
        )}
        <ComposerShell
          className="comparison-composer"
          onSubmit={(event) => event.preventDefault()}
        >
          {layout === "external" ? (
            <ComposerEditor
              aria-label="草稿正文布局示例"
              readOnly
              value={bundle.question}
            />
          ) : (
            inline(true)
          )}
          <div className="comparison-composer-footer">
            <Icon name="plus" size={16} />
            <span>ZenX</span>
            <span
              className="layout-send-marker"
              aria-label="发送按钮位置示意，不执行发送"
            >
              <Icon name="send" size={16} />
            </span>
          </div>
        </ComposerShell>
        {removed.length > 0 && (
          <button
            className="restore-sample"
            type="button"
            onClick={() => setRemoved([])}
          >
            恢复草稿样例
          </button>
        )}
      </div>
      <div className="layout-stage sent-stage">
        <div className="stage-label">
          发送后<span>同一初始实例 · 同一放置规则</span>
        </div>
        <div className="comparison-user-row">
          {layout === "external" && (
            <div className="adjunct-rail">{tokens(false)}</div>
          )}
          <div className="user-bubble">
            {layout === "external" ? (
              <Markdown text={bundle.question} />
            ) : (
              inline(false)
            )}
          </div>
        </div>
      </div>
      <footer className="option-note">
        {layout === "external"
          ? "附加内容与指令分开，适合对整组材料提一个问题。"
          : "引用与文字共同组织，适合逐处指代与连续说明。"}
      </footer>
    </section>
  );
}
const proposedDocument = {
  status: "PROPOSED_ONLY_NOT_SENT",
  version: 2,
  parts: [
    { type: "text", text: "请结合这些引用" },
    ...references.map((_reference, index) => ({
      type: "reference",
      ref: `r${index + 1}`,
    })),
    { type: "text", text: "说明实现边界，不要把指针当作已经读过的内容。" },
  ],
  references: references.map((reference, index) => ({
    key: `r${index + 1}`,
    target:
      reference.kind === "file"
        ? { kind: "file", cwd: reference.cwd, path: reference.path }
        : reference.kind === "thread"
          ? { kind: "thread", id: reference.id }
          : { kind: "message", threadId: reference.threadId, id: reference.id },
    label: reference.name,
    content:
      reference.kind === "message"
        ? { mode: "excerpt", text: reference.excerpt }
        : { mode: "pointer" },
  })),
};
function Inspector({ index, onClose }: { index: number; onClose(): void }) {
  const reference = references[index]!;
  const category = categories[index]!;
  const [source, setSource] = useState(false);
  const sourceText =
    reference.kind === "file"
      ? bundle.file.content
      : reference.kind === "message"
        ? bundle.sourceFullMessage
        : category === "subagent"
          ? "合成子线程：由目标 Thread 创建，尚无消息正文。"
          : bundle.sourcePrompt;
  return (
    <section
      className="reference-inspector"
      aria-label="引用详情"
      tabIndex={-1}
    >
      <header>
        <strong>
          {labels[category]} · {reference.name}
        </strong>
        <button type="button" onClick={onClose} aria-label="关闭引用详情">
          <Icon name="x" size={14} />
        </button>
      </header>
      <p className="reference-delivery">
        {reference.kind === "message"
          ? "已包含原文：下面的精确内容进入模型输入。"
          : "仅位置指针：名称与标识进入模型输入，不自动读取正文。"}
      </p>
      {reference.kind === "message" && (
        <pre className="reference-exact-excerpt">{reference.excerpt}</pre>
      )}
      <dl>
        <dt>类型</dt>
        <dd>
          {reference.kind}
          {category === "subagent"
            ? "（sub-agent 使用同一种 Thread 身份）"
            : ""}
        </dd>
        <dt>来源</dt>
        <dd>
          {reference.kind === "file"
            ? `${reference.cwd}/${reference.path}`
            : reference.kind === "thread"
              ? reference.id
              : `${reference.threadId} / ${reference.id}`}
        </dd>
      </dl>
      <button
        type="button"
        className="reference-source-link"
        onClick={() => setSource((v) => !v)}
      >
        {source ? "收起合成来源记录" : "查看合成来源记录"}
      </button>
      {source && (
        <div className="source-record">
          <p>只查看已保存的合成记录，不发送、不补充模型上下文。</p>
          <pre>{sourceText}</pre>
        </div>
      )}
    </section>
  );
}
function ContextEvidence() {
  const payload = referenceMessage(
    bundle.question,
    references,
    bundle.clientId,
  );
  if (payload !== bundle.canonicalText)
    throw new Error("Fixture no longer matches the captured canonical payload");
  return (
    <section className="context-evidence" data-current-payload={payload}>
      <h2>同一组引用，模型现在实际收到什么？</h2>
      <div className="context-facts">
        <p>
          <strong>线程、子线程、文件</strong>
          <span>只有名称 + ID / 路径；不含正文。</span>
        </p>
        <p>
          <strong>整条消息、选中文字</strong>
          <span>包含来源标识和精确原文快照。</span>
        </p>
        <p>
          <strong>当前还存在的缺口</strong>
          <span>引用被按类型重排，正文中的位置未保存。</span>
        </p>
      </div>
      <p className="evidence-scope">
        当前代码实测：真实 Host → Runtime → 内存 journal → 两种生产 provider
        adapter；仅 HTTP 用本地假实现接收，零联网、零模型调用。本例工具配置仅
        wait，未读取文件或线程正文。下方完整请求保留该配置。
      </p>
      <details>
        <summary>实际模型请求 · Chat Completions</summary>
        <pre>{JSON.stringify(chatRequest, null, 2)}</pre>
      </details>
      <details>
        <summary>实际模型请求 · Responses</summary>
        <pre>{JSON.stringify(responsesRequest, null, 2)}</pre>
      </details>
      <details>
        <summary>实际 canonical 用户消息文本</summary>
        <pre>{bundle.canonicalText}</pre>
      </details>
      <details className="proposed-context">
        <summary>拟议的有序文档 · 尚未实现、未发送给模型</summary>
        <p>
          text/reference 保留顺序；pointer 与 excerpt 明确区分。A/B
          只是同一文档的两种投影，不因换布局自动读取更多材料。
        </p>
        <pre>{JSON.stringify(proposedDocument, null, 2)}</pre>
      </details>
    </section>
  );
}
function App() {
  const [inspected, setInspected] = useState<number | null>(null);
  const layout = params.get("layout");
  const inspect = (index: number) => {
    setInspected(index);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(".reference-inspector")
        ?.focus({ preventScroll: true }),
    );
  };
  return (
    <main className={`layout-comparison${layout ? " single-layout" : ""}`}>
      <header className="comparison-heading">
        <div className="comparison-eyebrow">ZENX / 统一引用体系 / 合成数据</div>
        <h1>五种引用，一个完整的放置规则</h1>
        <p>线程 · 消息 · sub-agent 线程 · 选中文字 · 文件</p>
        <div className="prototype-boundary">
          布局提案，不执行发送；@消息选择入口尚未接入，样例使用现有 message
          snapshot。
        </div>
      </header>
      <div className="comparison-grid">
        {layout !== "inline" && (
          <Variant layout="external" onInspect={inspect} />
        )}{" "}
        {layout !== "external" && (
          <Variant layout="inline" onInspect={inspect} />
        )}
      </div>
      {inspected !== null && (
        <Inspector
          key={inspected}
          index={inspected}
          onClose={() => setInspected(null)}
        />
      )}
      <ContextEvidence />
      <footer className="comparison-footnote">
        A/B 为待选结构，并非已接入的生产发送
        UI。点击任一引用查看同一套详情、来源与内容策略；只有草稿可移除。实际请求、当前限制与未实现的提案分别列示。
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
