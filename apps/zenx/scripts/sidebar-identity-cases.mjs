/** Fixed synthetic titles only. No generated names, real project text or live mutations. */
export const sidebarIdentityCases = Object.freeze({
  "en-extension": {
    lang: "en",
    title:
      "Design review · shared component accessibility and release readiness",
    siblingTitle:
      "Design review · shared component accessibility and release readiness · alternate review",
  },
  "zh-extension": {
    lang: "zh-CN",
    title: "设计评审 · 桌面共享组件无障碍与发布就绪检查",
    siblingTitle: "设计评审 · 桌面共享组件无障碍与发布就绪检查 · 备选方案复核",
  },
  "en-shared-tail": {
    lang: "en",
    title:
      "Design review · shared component keyboard navigation · release readiness",
    siblingTitle:
      "Design review · shared component screen reader · release readiness",
  },
  "zh-shared-tail": {
    lang: "zh-CN",
    title: "设计评审 · 桌面共享组件键盘导航检查结果",
    siblingTitle: "设计评审 · 桌面共享组件屏幕阅读检查结果",
  },
});
export function sidebarIdentityCase(name) {
  if (!Object.hasOwn(sidebarIdentityCases, name))
    throw new Error("Unknown fixed sidebar identity case");
  return sidebarIdentityCases[name];
}
