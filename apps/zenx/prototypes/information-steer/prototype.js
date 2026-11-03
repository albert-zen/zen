/** Static review prototype logic only. No product code, no Host, no network. */
const params = new URLSearchParams(location.search);
const body = document.body;

const initial = {
  variant: params.get("v") === "b" ? "b" : "a",
  state: params.get("state") === "entered" ? "entered" : "pending",
  theme: params.get("theme") === "light" ? "light" : "dark",
};

function sync() {
  for (const button of document.querySelectorAll("[data-set-variant]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.setVariant === body.dataset.variant),
    );
  }
  for (const button of document.querySelectorAll("[data-set-state]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.setState === body.dataset.state),
    );
  }
  for (const button of document.querySelectorAll("[data-set-theme]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.setTheme === body.dataset.theme),
    );
  }
}

body.dataset.variant = initial.variant;
body.dataset.state = initial.state;
body.dataset.theme = initial.theme;
body.dataset.chrome = params.get("chrome") === "0" ? "0" : "1";
sync();

for (const button of document.querySelectorAll("[data-set-variant]")) {
  button.addEventListener("click", () => {
    body.dataset.variant = button.dataset.setVariant;
    sync();
  });
}
for (const button of document.querySelectorAll("[data-set-state]")) {
  button.addEventListener("click", () => {
    body.dataset.state = button.dataset.setState;
    sync();
  });
}
for (const button of document.querySelectorAll("[data-set-theme]")) {
  button.addEventListener("click", () => {
    body.dataset.theme = button.dataset.setTheme;
    sync();
  });
}

let toastTimer;
function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

/* Automation rows: the switch is the state; the rest of the row opens the editor. */
for (const toggle of document.querySelectorAll(".switch")) {
  toggle.addEventListener("click", () => {
    const on = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(on));
    toggle.closest(".trigger").dataset.on = String(on);
  });
}

/* Question options behave as one radio group with number-key shortcuts. */
const options = [...document.querySelectorAll("[data-option]")];
function select(index) {
  options.forEach((option, position) => {
    option.setAttribute("aria-checked", String(position === index));
  });
}
options.forEach((option, index) => {
  option.addEventListener("click", () => select(index));
});

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
    return;
  const digit = Number.parseInt(event.key, 10);
  if (!Number.isNaN(digit) && digit >= 1 && digit <= options.length) {
    event.preventDefault();
    select(digit - 1);
  }
});

/* Free-text fields grow without a resize handle. */
for (const field of document.querySelectorAll("textarea")) {
  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };
  field.addEventListener("input", grow);
  grow();
}

/* Recall merges the pending snapshot back into the Composer draft. */
const pendingTexts = [
  "等一下，先把 390px 窄窗的截图补上，再继续后面的检查。",
  "还有，深色下问题卡和待发送区域也一起看一遍。",
];
for (const recall of document.querySelectorAll("[data-recall]")) {
  recall.addEventListener("click", () => {
    body.dataset.recalled = "true";
    const composer = document.getElementById("composer-input");
    const existing = composer.value.trim();
    composer.value = [ ...pendingTexts, existing ].filter(Boolean).join("\n\n");
    composer.dispatchEvent(new Event("input"));
    composer.focus();
    toast("已把 2 条消息撤回输入框，没有重发");
  });
}

const sendAnswer = document.querySelector("[data-send-answer]");
sendAnswer?.addEventListener("click", () => {
  toast("回答已发送（原型演示）");
});
document
  .querySelector("[data-cancel-question]")
  ?.addEventListener("click", () => toast("已取消这次请求（原型演示）"));
