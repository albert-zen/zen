/** Build the real renderer fixture as a portable, offline review document. */
import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const out = path.resolve(
  process.argv[2] ?? path.join(root, ".process-style-preview"),
);
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(
        root,
        "apps/zenx/test/fixtures/process-style-visual.tsx",
      ),
      name: "ProcessStylePreview",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output
  .filter((value) => value.type === "chunk")
  .map((value) => value.code)
  .join("\n");
const css = output
  .filter((value) => value.type === "asset" && value.fileName.endsWith(".css"))
  .map((value) => String(value.source))
  .join("\n");
if (!js || !css)
  throw new Error("Missing fixture JavaScript or production CSS");
const frame = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZenX process styling · synthetic</title><style>${css}</style><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
const scenes = [
  ["thinking", "Thinking + 长流式正文"],
  ["thinking-short", "Thinking + 短正文"],
  ["thinking-empty", "Thinking · 暂无公开正文"],
  ["command-long", "执行中 · 完整长命令"],
  ["command-short", "执行中 · 短命令"],
  ["waiting", "等待工具"],
  ["wait-lifecycle", "Wait lifecycle · synthetic"],
  ["running", "执行中"],
  ["parallel", "并行工具"],
  ["approval", "等待审批"],
  ["stopping", "停止请求中"],
  ["stopped", "已停止"],
  ["failed", "失败与重试"],
  ["recovery", "自动恢复"],
  ["completed", "已完成"],
];
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZenX · 样式修正预览</title><style>html,body{margin:0;height:100%;font:13px system-ui;background:#e8e9ec;color:#20232b}body{display:flex;flex-direction:column}header{padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-bottom:1px solid #cdd0d7}select,button{font:inherit;padding:6px 10px;border:1px solid #c3c7d1;border-radius:6px;background:#fff;color:inherit}small{color:#59616e}main{flex:1;min-height:0;display:flex;justify-content:center;padding:12px}iframe{width:100%;height:100%;border:1px solid #cdd0d7;border-radius:10px;background:#fff}iframe.narrow{width:420px;max-width:100%}</style><body><header><b>ZenX · 样式修正候选</b><select id="scene">${scenes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select><select id="theme"><option value="light">浅色</option><option value="dark">深色</option></select><button id="width">切换窄屏</button><button id="stream">追加流式正文</button><button id="short">短正文 / 命令</button><button id="long">长正文 / 命令</button><button id="finish">完成当前这一轮</button><button id="reset">重置</button><small>合成数据 · 实际组件 · 无 Host；公开正文模拟流式更新 · 完整命令 · 共享扫光 · 48px 尾部渐隐</small></header><main><iframe id="preview" title="实际 ZenX 组件预览"></iframe></main><script>const frame=${JSON.stringify(frame).replaceAll("<", "\\u003c")};const preview=document.querySelector('#preview');preview.srcdoc=frame;function api(){return preview.contentWindow.__processStylePreview}document.querySelector('#scene').onchange=e=>api().selectScene(e.target.value);document.querySelector('#theme').onchange=e=>api().setTheme(e.target.value);document.querySelector('#width').onclick=()=>preview.classList.toggle('narrow');document.querySelector('#stream').onclick=()=>api().streamStep();for(const size of ['short','long'])document.querySelector('#'+size).onclick=()=>{api().setReasoning(api().samples.publicReasoning[size]);api().setCommand(api().samples.commands[size])};document.querySelector('#finish').onclick=()=>api().finish();document.querySelector('#reset').onclick=()=>api().reset();</script></body></html>`;
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "process-style-preview.html"), html);
await writeFile(path.join(out, "process-style-frame.html"), frame);
await writeFile(
  path.join(out, "README.txt"),
  "Synthetic, read-only preview built from production Sidebar, ThreadView, ActivityText, styles and theme. No Host/network actions. Select long, short, or empty public reasoning and full-command scenes. Append a synthetic public item.content update, or switch between long and short payloads without replacing the item. Expand the original trace and item controls, then finish the SAME turn to inspect metadata stability. Production DSH width-relative shared icon/text mask: 105deg, 1.5s steps(48, end), 0.3s delay, -100% to +100% through 66.6667% then hold. Overflow uses one line with a 48px trailing fade. Capture checks light/dark/narrow, reduced motion, streaming identity, and actual icon/text pixel differences. All displayed reasoning is authored synthetic fixture data, not hidden model reasoning.\n",
);
console.log(out);
