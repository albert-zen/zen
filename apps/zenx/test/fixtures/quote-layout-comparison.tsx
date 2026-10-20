import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageQuoteCard } from "../../src/renderer/src/message-quote.js";
import {
  ComposerShell,
  ComposerEditor,
} from "../../src/renderer/src/Composer.js";
import { Icon } from "../../src/renderer/src/icons.js";
import { Markdown } from "../../src/renderer/src/Markdown.js";
import {
  referenceMessage,
  parseSentReferenceMessage,
} from "../../src/renderer/src/reference-draft.js";
import type {
  MessageQuoteReference,
  Reference,
} from "../../src/renderer/src/composer-selector.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "./quote-layout-comparison.css";
Object.assign(globalThis, { React });
void i18n.changeLanguage("zh-CN");
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const question = "参考设计文件和页面截图，把这部分的展开行为讲清楚。";
const file: Reference = {
  kind: "file",
  name: "interaction.md",
  cwd: "/synthetic/zenx",
  path: "docs/interaction.md",
};
const shortQuote = "按需展开";
const longQuote =
  "完成后保留结果，具体命令和输出按需展开。\n\nconst excerpt = selection.toString();\n// 保留准确原文与换行，不随展示方式改变。";
const makeQuote = (long: boolean): MessageQuoteReference => ({
  kind: "message",
  name: "ZenX",
  cwd: "/synthetic/zenx",
  threadId: "layout-demo",
  id: "source-demo",
  excerpt: long ? longQuote : shortQuote,
});
function AssetChip({
  kind,
  draft,
  onRemove,
}: {
  kind: "file" | "image";
  draft: boolean;
  onRemove(): void;
}) {
  return (
    <span className="layout-asset" data-adjunct={kind}>
      <Icon name={kind === "file" ? "file" : "image"} size={13} />
      <span>{kind === "file" ? "interaction.md" : "page.png"}</span>
      {draft && (
        <button
          type="button"
          aria-label={`移除${kind === "file" ? "设计文件" : "页面截图"}`}
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
  quote,
}: {
  layout: "external" | "inline";
  quote: MessageQuoteReference;
}) {
  const [removed, setRemoved] = useState<string[]>([]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const refs = [
    !removed.includes("file") ? file : null,
    !removed.includes("quote") ? quote : null,
  ].filter((value): value is Reference => value !== null);
  const payload = referenceMessage(question, refs, "layout-preview-send");
  const sent = parseSentReferenceMessage(payload, "layout-preview-send");
  // Only quotes are recovered from the real canonical envelope. Asset placement
  // is a synthetic design sample, not a parser or persisted ordering claim.
  const sentQuote = sent.quotes[0] ? { ...quote, ...sent.quotes[0] } : null;
  const remove = (kind: string) => () => setRemoved((v) => [...v, kind]);
  function quoteCard(draft: boolean) {
    const visible = draft
      ? !removed.includes("quote")
        ? quote
        : null
      : sentQuote;
    return (
      visible && (
        <MessageQuoteCard
          reference={visible}
          onSource={() => {
            setSourceOpen(true);
            return true;
          }}
          onRemove={draft ? remove("quote") : undefined}
        />
      )
    );
  }
  function asset(kind: "file" | "image", draft: boolean) {
    return (
      !removed.includes(kind) && (
        <AssetChip kind={kind} draft={draft} onRemove={remove(kind)} />
      )
    );
  }
  function adjuncts(draft: boolean) {
    return (
      <>
        {asset("file", draft)}
        {asset("image", draft)}
        {quoteCard(draft)}
      </>
    );
  }
  function inline(draft: boolean) {
    return (
      <div className="inline-sequence" aria-label="正文内混合排列示例">
        <span>参考 </span>
        {asset("file", draft)}
        <span> 和 </span>
        {asset("image", draft)}
        <span>，把 </span>
        {quoteCard(draft)}
        <span> 这部分的展开行为讲清楚。</span>
      </div>
    );
  }
  return (
    <section className={`layout-option layout-${layout}`} data-layout={layout}>
      <header className="option-heading">
        <span className="option-letter">
          {layout === "external" ? "A" : "B"}
        </span>
        <div>
          <h2>
            {layout === "external"
              ? "附加内容放在气泡外"
              : "所有内容进入正文流"}
          </h2>
          <p>
            {layout === "external"
              ? "正文只放问题；文件、截图、引用统一在外侧。"
              : "文字、文件、截图、引用按阅读顺序混排。"}
          </p>
        </div>
      </header>
      <div className="layout-stage draft-stage">
        <div className="stage-label">
          草稿{" "}
          <span>
            {layout === "inline" ? "排布样例，未启用富文本编辑" : "布局样例"}
          </span>
        </div>
        {layout === "external" && (
          <div className="adjunct-rail" aria-label="气泡外附加内容">
            {adjuncts(true)}
          </div>
        )}
        <ComposerShell
          onSubmit={(event) => event.preventDefault()}
          className="comparison-composer"
        >
          {layout === "external" ? (
            <ComposerEditor
              aria-label="草稿正文布局示例"
              readOnly
              value={question}
            />
          ) : (
            inline(true)
          )}
          <div className="comparison-composer-footer">
            <Icon name="plus" size={16} />
            <span>ZenX</span>
            <span className="layout-send-marker" aria-label="发送按钮位置示意">
              <Icon name="send" size={16} />
            </span>
          </div>
        </ComposerShell>
      </div>
      <div className="layout-stage sent-stage">
        <div className="stage-label">
          发送后 <span>同一种放置规则</span>
        </div>
        <div className="comparison-user-row">
          {layout === "external" && (
            <div className="adjunct-rail" aria-label="气泡外附加内容">
              {adjuncts(false)}
            </div>
          )}
          <div className="user-bubble">
            {layout === "external" ? (
              <Markdown text={question} />
            ) : (
              inline(false)
            )}
          </div>
        </div>
      </div>
      <footer className="option-note">
        {layout === "external"
          ? "适合：先附上上下文，再写一个整体问题。"
          : "适合：逐处指代、边引用边写，多段内容一起组织。"}
      </footer>
      {sourceOpen && (
        <div className="source-preview" role="region" aria-label="合成引用原文">
          <div>
            <strong>合成引用原文</strong>
            <button type="button" onClick={() => setSourceOpen(false)}>
              关闭
            </button>
          </div>
          <pre>{quote.excerpt}</pre>
        </div>
      )}
      <details className="payload-details">
        <summary>数据边界与真实 payload</summary>
        <p>
          布局比较，不调用模型。引用通过现有序列化器往返；文件与截图位置是合成设计样例，不新增解析或持久化。B
          的混排顺序未写入现有文本 payload。
        </p>
        <pre>{payload}</pre>
      </details>
      {removed.length > 0 && (
        <button
          type="button"
          className="restore-sample"
          onClick={() => setRemoved([])}
        >
          恢复样例
        </button>
      )}
    </section>
  );
}
function App() {
  const [long, setLong] = useState(params.has("long"));
  return (
    <main className="layout-comparison">
      <header className="comparison-heading">
        <div className="comparison-eyebrow">ZENX / 消息结构对照 / 合成数据</div>
        <h1>同一组上下文，两种放置方式</h1>
        <p>不再混用气泡内、气泡外两套规则。先选结构，再做细节。</p>
        <label>
          <input
            type="checkbox"
            checked={long}
            onChange={(event) => setLong(event.target.checked)}
          />
          查看长引用
        </label>
      </header>
      <div className="comparison-grid">
        <Variant layout="external" quote={makeQuote(long)} />
        <Variant layout="inline" quote={makeQuote(long)} />
      </div>
      <footer className="comparison-footnote">
        A 按你描述的 Codex 方向；B 按你描述的 WorkBuddy
        方向。此页是结构对照，不代表两款产品的逐像素复刻，也不执行发送。
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
