import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const productionStylePolicy = "style-src 'self'";
const developmentStylePolicy = "style-src 'self' 'unsafe-inline'";

function quotedAttribute(markup: string, name: string) {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  ).exec(markup);
  if (match === null) return undefined;

  const value = match[1] ?? match[2];
  if (value === undefined) return undefined;
  const quote = match[1] === undefined ? "'" : '"';
  const valueStart = match.index + match[0].indexOf(quote) + 1;
  return { value, valueStart, valueEnd: valueStart + value.length };
}

function allowViteDevelopmentStyles(html: string): string {
  const cspMetas = [...html.matchAll(/<!--[\s\S]*?-->|<meta\b[^>]*>/giu)]
    .filter((match) => !match[0].startsWith("<!--"))
    .flatMap((match) => {
      const httpEquiv = quotedAttribute(match[0], "http-equiv");
      return httpEquiv?.value.toLowerCase() === "content-security-policy"
        ? [{ markup: match[0], start: match.index }]
        : [];
    });
  const cspMeta = cspMetas[0];
  if (cspMetas.length !== 1 || cspMeta === undefined) {
    throw new Error(
      `ZenX renderer must contain exactly one CSP meta; found ${cspMetas.length}`,
    );
  }

  const content = quotedAttribute(cspMeta.markup, "content");
  if (content === undefined) {
    throw new Error("ZenX renderer CSP meta is missing its content attribute");
  }

  const directives = content.value.split(";");
  const styleDirectiveIndexes = directives.flatMap((directive, index) =>
    /^\s*style-src(?:\s|$)/iu.test(directive) ? [index] : [],
  );
  const styleDirectiveIndex = styleDirectiveIndexes[0];
  if (styleDirectiveIndexes.length !== 1 || styleDirectiveIndex === undefined) {
    throw new Error(
      `ZenX renderer CSP must contain exactly one style-src directive; found ${styleDirectiveIndexes.length}`,
    );
  }

  const styleDirective = directives[styleDirectiveIndex];
  if (
    styleDirective === undefined ||
    styleDirective.trim().replace(/\s+/gu, " ") !== productionStylePolicy
  ) {
    throw new Error(
      "ZenX renderer CSP has an unexpected production style policy",
    );
  }
  const leadingWhitespace = /^\s*/u.exec(styleDirective)?.[0] ?? "";
  const trailingWhitespace = /\s*$/u.exec(styleDirective)?.[0] ?? "";
  directives[styleDirectiveIndex] =
    leadingWhitespace + developmentStylePolicy + trailingWhitespace;

  const valueStart = cspMeta.start + content.valueStart;
  const valueEnd = cspMeta.start + content.valueEnd;
  return (
    html.slice(0, valueStart) + directives.join(";") + html.slice(valueEnd)
  );
}

const viteDevelopmentCsp: Plugin = {
  name: "zenx-vite-development-csp",
  apply: "serve",
  transformIndexHtml: allowViteDevelopmentStyles,
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "app-server-host": resolve(__dirname, "src/main/app-server-host.ts"),
          "capability-smoke": resolve(
            __dirname,
            "src/main/capability-smoke.ts",
          ),
          "packaged-provider-smoke": resolve(
            __dirname,
            "src/main/packaged-provider-smoke.ts",
          ),
          "real-smoke": resolve(__dirname, "src/main/real-smoke.ts"),
          "provider-smoke": resolve(__dirname, "src/main/provider-smoke.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [viteDevelopmentCsp, react()],
  },
});
