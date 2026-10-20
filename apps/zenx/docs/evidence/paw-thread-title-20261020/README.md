# PAW/Room 工作 Thread 标题显示：修复前后

对象：`apps/zenx/src/renderer/src/thread-list.ts` `threadTitle()`（issue #449）。

## 合成数据边界

两张截图由 `apps/zenx/test/fixtures/paw-thread-title-visual.html` 渲染**真实生产 Sidebar**
产生，数据全部为合成：伪造的 Thread 名称、伪造的 Room 号与唤醒原文；没有真实任务、
Provider 调用或 profile 写入。Fixtures 与截图对应各自的代码版本，不能冒充运行中的真实项目。

三行分别是：

1. `legacy-named`：名称本身是未经修改的唤醒原文 → 保留简短披露标签。
2. `named-paw`：PAW/Room 工作 Thread，第一条消息是 Room 唤醒原文，**有自己的名称** → 必须显示该名称。
3. `unnamed-paw`：同一条唤醒消息，但还没有名称 → 只有这种情况回退到第一条消息预览。

## 截图

- `01-before-wakeup-substitute.png`：修复前（`dfd427541ced50a4c076ca131d4fd8e9107336f3`）。
  第 2 行被替身覆盖，显示 `房间唤醒 · 63c6c01d`，与 issue 报告的现象一致。
- `02-after-thread-name.png`：修复后（本 PR 的 head）。第 2 行显示其自身名称，第 3 行回退到第一条消息预览。

## 复核方式

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175
# 打开 /apps/zenx/test/fixtures/paw-thread-title-visual.html
```
