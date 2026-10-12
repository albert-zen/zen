import type { SupportedLanguage } from "../locale.js";

const en = {
  edit: "Edit",
  view: "View",
  window: "Window",
  about: "About ZenX",
  hide: "Hide ZenX",
  hideOthers: "Hide Others",
  quit: "Quit ZenX",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select All",
  resetZoom: "Actual Size",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  minimize: "Minimize",
  close: "Close Window",
  keepEditing: "Keep editing",
  leaveWindow: "Leave window",
  leaveUnsaved: "Leave with unsaved file edits?",
  quitUnsaved: "Quit with unsaved file edits?",
  unsavedDetail:
    "Unsaved drafts will be lost. A save already in progress may still finish.",
  chooseImages: "Choose images",
  images: "Images",
  installPlugin: "Install ZenX plugin tarball",
  pluginTarball: "npm package tarball",
};
const zhCN: Record<keyof typeof en, string> = {
  edit: "编辑",
  view: "视图",
  window: "窗口",
  about: "关于 ZenX",
  hide: "隐藏 ZenX",
  hideOthers: "隐藏其他应用",
  quit: "退出 ZenX",
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  copy: "复制",
  paste: "粘贴",
  selectAll: "全选",
  resetZoom: "实际大小",
  zoomIn: "放大",
  zoomOut: "缩小",
  minimize: "最小化",
  close: "关闭窗口",
  keepEditing: "继续编辑",
  leaveWindow: "离开窗口",
  leaveUnsaved: "放弃未保存的文件编辑并离开？",
  quitUnsaved: "放弃未保存的文件编辑并退出？",
  unsavedDetail: "未保存的草稿将丢失。正在进行的保存仍可能完成。",
  chooseImages: "选择图片",
  images: "图片",
  installPlugin: "安装 ZenX 插件压缩包",
  pluginTarball: "npm 插件压缩包",
};
let language: SupportedLanguage = "en";
export function setNativeLanguage(next: SupportedLanguage): boolean {
  const changed = next !== language;
  language = next;
  return changed;
}
export function nativeText(key: keyof typeof en): string {
  return (language === "zh-CN" ? zhCN : en)[key];
}
