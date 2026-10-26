import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
const repo = process.cwd();
const directory = path.resolve(process.argv[2] ?? ".reference-width-preview");
fs.mkdirSync(directory, { recursive: true });
const src = repo + "/apps/zenx/src/renderer/src";
const clientId = "synthetic-reference-width-client";
const ref = {
  kind: "message",
  name: "ZenX",
  cwd: "/tmp/zen-reference-width-synthetic",
  threadId: "synthetic-reference-width-thread",
  id: "synthetic-reference-width-message",
  contentMode: "excerpt",
  excerpt:
    "rtk v0.48.0 的 tarball（prepare-rtk.mjs 每次构建都重新拉）\nelectron v43.2.0 的 SHASUMS256.txt\nelectron-v43.2.0-darwin-arm64.zip",
};
const payload = (r) =>
  '[zenx-reference-message:v3;clientId="' +
  clientId +
  '"]\n[ZenX reference: ' +
  JSON.stringify(r) +
  "]合理吗";
const cases = [
  ["三行摘录（合成身份）", payload(ref)],
  ["短引用对照", payload({ ...ref, excerpt: "短引用" })],
  [
    "相同摘录单行对照",
    payload({ ...ref, excerpt: ref.excerpt.replaceAll("\n", " ") }),
  ],
];
cases.push([
  "两条引用与 Markdown 混排",
  '[zenx-reference-message:v3;clientId="' +
    clientId +
    '"]\n**比较** [ZenX reference: ' +
    JSON.stringify(ref) +
    "] 与 [ZenX reference: " +
    JSON.stringify({
      ...ref,
      id: "synthetic-second-reference",
      excerpt: "短引用",
    }) +
    "]，再看 \`code\`。",
]);
cases.push([
  "长无空格摘录",
  payload({ ...ref, excerpt: "reference".repeat(80) }),
]);
const code = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {InlineReferenceContent} from '${src}/InlineReferenceContent.tsx'; import {parseSentReferenceContent} from '${src}/reference-draft.ts'; import {i18n} from '${src}/i18n.ts'; import '${src}/theme.css'; import '${src}/styles.css';
i18n.changeLanguage('zh-CN'); const cases=${JSON.stringify(cases)}; createRoot(document.getElementById('root')).render(<main>{cases.map(([name,payload],i)=>{const p=parseSentReferenceContent(payload,${JSON.stringify(clientId)});return <section key={i} data-case={i}><h2>{name}</h2><article className="user-row"><div className="user-bubble"><InlineReferenceContent text={p.text} references={p.references}/></div></article></section>})}<button id="measure" onClick={()=>measure()}>测量当前盒模型</button><pre id="metrics"/></main>); window.referenceExcerpt=${JSON.stringify(ref.excerpt)}; function measure(){const data=[...document.querySelectorAll('section')].map(s=>({name:s.querySelector('h2').textContent,boxes:[...s.querySelectorAll('.user-bubble,.inline-reference-content,.markdown-body,p,.reference-token,.reference-token-details')].map(e=>({class:e.className||e.tagName,x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,clientWidth:e.clientWidth,height:e.getBoundingClientRect().height,scrollWidth:e.scrollWidth}))}));document.querySelector('#metrics').textContent=JSON.stringify(data,null,2);window.layoutMetrics=data;} setTimeout(measure,500); window.addEventListener('resize',measure);`;
(async () => {
  const r = await esbuild.build({
    stdin: { contents: code, resolveDir: repo, loader: "tsx" },
    bundle: true,
    write: false,
    outdir: directory,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: {
      ".woff2": "dataurl",
      ".woff": "dataurl",
      ".svg": "dataurl",
      ".png": "dataurl",
    },
  });
  const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const css = r.outputFiles.find((f) => f.path.endsWith(".css")).text;
  fs.writeFileSync(
    path.join(directory, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>ZenX reference width diagnostic — synthetic identity</title><style>' +
      css +
      '</style><style>body{overflow:auto!important;margin:0;padding:28px;display:block!important}main{max-width:1000px;margin:auto}section{margin:22px 0;padding:15px;border:1px dashed #777}h2{font-size:16px;margin:0 0 16px}#metrics{white-space:pre-wrap;font-size:11px}#measure{margin:10px;padding:10px}</style><div id="root"></div><script>' +
      js.replaceAll("</script", "<\\/script") +
      "</script>",
  );
  console.log(
    "built index.html bytes",
    fs.statSync(path.join(directory, "index.html")).size,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
