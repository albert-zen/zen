import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const groups = ["kernel", "product", "adapters/node", "presentation", "tui"] as const;
type Group = (typeof groups)[number];

const allowed: Record<Group, readonly Group[]> = {
  kernel: ["kernel"],
  product: ["kernel", "product"],
  "adapters/node": ["kernel", "product", "adapters/node"],
  presentation: ["kernel", "product", "presentation"],
  tui: ["kernel", "product", "presentation", "tui", "adapters/node"]
};

describe("module boundaries", () => {
  it("uses explicit group entrypoints for cross-group production imports", () => {
    for (const sourceFile of sourceFiles()) {
      const from = groupFor(sourceFile);
      const imports = importsOf(sourceFile);

      for (const specifier of imports) {
        if (!specifier.startsWith(".")) continue;
        const target = resolveModule(sourceFile, specifier);
        if (!target || !target.startsWith(resolve(root, "src"))) continue;
        const to = groupFor(target);
        expect(allowed[from]).toContain(to);
        if (from !== to) expect(specifier).toMatch(/index\.js$/u);
      }
    }
  });

  it("keeps the root package surface kernel-only and publishes all group subpaths", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(Object.keys(packageJson.exports)).toEqual([".", "./product", "./node", "./presentation", "./tui"]);
    expect(packageJson.exports["."].default).toBe("./dist/kernel/index.js");
    for (const entry of Object.values(packageJson.exports)) {
      expect(entry.default).toContain("/index.js");
      expect(entry.types).toContain("/index.d.ts");
    }
  });

  it("keeps acceptance outside production declarations and Web source on aliases", () => {
    const build = JSON.parse(readFileSync(resolve(root, "tsconfig.build.json"), "utf8")) as { exclude: string[] };
    expect(build.exclude).toContain("acceptance/**/*.ts");
    for (const sourceFile of [resolve(root, "web/src/demo-app-server.ts"), resolve(root, "web/src/workspace.tsx")]) {
      for (const specifier of importsOf(sourceFile)) {
        expect(specifier).not.toMatch(/^\.\.\/\.\.\/src/u);
      }
    }
  });
});

function sourceFiles(): readonly string[] {
  return groups.flatMap((group) => ts.sys.readDirectory(resolve(root, "src", group), [".ts"], undefined, ["**/*.ts"]));
}

function importsOf(path: string): readonly string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  source.forEachChild((node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) values.push(node.moduleSpecifier.text);
  });
  return values;
}

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(from, "..");
  for (const candidate of [resolve(base, specifier), resolve(base, specifier.replace(/\.js$/u, ".ts"))]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function groupFor(path: string): Group {
  const relative = path.slice(resolve(root, "src").length + 1).replaceAll("\\", "/");
  return groups.find((group) => relative === group || relative.startsWith(`${group}/`)) ?? "kernel";
}
