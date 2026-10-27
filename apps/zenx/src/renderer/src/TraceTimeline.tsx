import type { TraceTimeline as Timeline } from "../../../../cli/src/model-request-debug-types.js";
const labels: Record<string, [string, string]> = {
  context_preparation_started: [
    "Context preparation started",
    "上下文准备开始",
  ],
  context_preparation_finished: [
    "Context preparation finished",
    "上下文准备结束",
  ],
  context_materialize_started: [
    "Semantic inputs materialization started",
    "语义输入落盘开始",
  ],
  context_materialize_finished: [
    "Semantic inputs materialization finished",
    "语义输入落盘结束",
  ],
  context_compile_started: ["Context compilation started", "上下文编译开始"],
  context_compile_finished: ["Context compilation finished", "上下文编译结束"],
  model_sample_started: ["Adapter sample started", "模型适配器采样开始"],
  request_prepared: ["Request bytes prepared", "请求字节已准备"],
  fetch_invoked: ["Fetch invoked", "实际调用 Fetch"],
  response_headers: ["First response headers received", "首次收到响应头"],
  first_response_bytes: ["First response bytes received", "首次收到响应字节"],
  first_exposed_reasoning: [
    "First exposed reasoning received",
    "首次收到公开推理内容",
  ],
  first_exposed_summary: [
    "First reasoning summary received",
    "首次收到推理摘要",
  ],
  first_exposed_text: ["First text received", "首次收到文本"],
  model_sample_finished: ["Adapter sample finished", "模型适配器采样结束"],
  raw_eof: ["Raw response EOF observed", "原始响应 EOF 已观测"],
};
/** Read-only derived milestones. Missing evidence stays visible instead of guessed. */
export function TraceTimeline({
  timeline,
  zh,
}: {
  timeline: Timeline;
  zh: boolean;
}) {
  const tr = (en: string, cn: string) => (zh ? cn : en);
  const label = (key: string) => labels[key]?.[zh ? 1 : 0] ?? key;
  const time = (value: { wallTime: string } | null) =>
    value ? (
      <time dateTime={value.wallTime}>{value.wallTime}</time>
    ) : (
      tr("Unobserved / unknown", "未观测 / 未知")
    );
  return (
    <section
      className="trace-timeline"
      aria-label={tr("Observed timing milestones", "已观测时间线")}
    >
      <h4>{tr("Observed timing milestones", "已观测时间线")}</h4>
      <p>
        {tr(
          "UI clocks are client-reported and not synchronized with the Host. Exact UI → Host latency, DNS/TLS and provider queue time are unknown. First content means an exposed event arrived, not hidden thinking or exact token generation.",
          "UI 时钟由客户端报告，未与 Host 同步；UI → Host 精确耗时、DNS/TLS 与提供方排队时间未知。首次内容表示收到公开事件，不代表隐藏思考开始或精确 token 生成时刻。",
        )}
      </p>
      {timeline.inputs.length === 0 ? (
        <p>
          {tr(
            "UI activation and Host receipt: unobserved",
            "UI 发送操作与 Host 收件：未观测",
          )}
        </p>
      ) : (
        timeline.inputs.map((input) => (
          <div className="trace-timeline-input" key={input.requestId}>
            <dl>
              <dt>{tr("UI activation (reported)", "UI 发送操作（报告值）")}</dt>
              <dd>{time(input.activation)}</dd>
              <dt>{tr("Host receipt", "Host 收到请求")}</dt>
              <dd>{time(input.received)}</dd>
              <dt>
                {tr(
                  "Admission outcome, not execution completion",
                  "准入结果（非执行完成）",
                )}
              </dt>
              <dd>{input.outcome}</dd>
            </dl>
            <details>
              <summary>
                {tr("Clock and correlation identities", "时钟与关联标识")}
              </summary>
              <pre>{JSON.stringify(input, null, 2)}</pre>
            </details>
          </div>
        ))
      )}
      <dl className="trace-timeline-stages">
        {timeline.stages.map((point) => (
          <div key={point.stage} data-timing-stage={point.stage}>
            <dt>{label(point.stage)}</dt>
            <dd>
              {time(point.clock)}
              {point.outcome ? ` · ${point.outcome}` : null}
              {point.elapsedFrom && (
                <small>
                  {point.elapsedMs === null
                    ? tr("Interval unknown", "间隔未知")
                    : `${point.elapsedMs.toFixed(3)} ms`}{" "}
                  · {tr("from ", "起点：")}
                  {label(point.elapsedFrom)}
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p>
        {tr(
          "Only same-clock intervals are measured. Local capture and client/provider work are included; these are not network-only durations. Input associations do not prove causality.",
          "仅计算同一时钟域的间隔，包含本机捕获及客户端/提供方处理，不是纯网络耗时。输入关联不等于因果证明。",
        )}
      </p>
    </section>
  );
}
