import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const frameworkRoot = resolve(root, 'packages/framework');
const sourceRoot = resolve(frameworkRoot, 'src');
const groups = ['kernel', 'product', 'adapters/node', 'presentation'] as const;
type Group = (typeof groups)[number];

const allowed: Record<Group, readonly Group[]> = {
  kernel: ['kernel'],
  product: ['kernel', 'product'],
  'adapters/node': ['kernel', 'product', 'adapters/node'],
  presentation: ['kernel', 'product', 'presentation'],
};

describe('module boundaries', () => {
  it('uses explicit group entrypoints for cross-group production imports', () => {
    for (const sourceFile of sourceFiles()) {
      const from = groupFor(sourceFile);
      for (const specifier of importsOf(sourceFile)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolveModule(sourceFile, specifier);
        if (!target?.startsWith(sourceRoot)) continue;
        const to = groupFor(target);
        expect(allowed[from]).toContain(to);
        if (from !== to && !isInternalLegacyRuntimeImport(from, to, specifier)) {
          expect(specifier).toMatch(/index\.js$/u);
        }
      }
    }
  });

  it('publishes the framework kernel and named group subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(frameworkRoot, 'package.json'), 'utf8')
    ) as { exports: Record<string, { types: string; default: string }> };
    expect(Object.keys(packageJson.exports)).toEqual([
      '.',
      './product',
      './node',
      './presentation',
    ]);
    expect(packageJson.exports['.'].default).toBe('./dist/kernel/index.js');
    for (const entry of Object.values(packageJson.exports)) {
      expect(entry.default).toContain('/index.js');
      expect(entry.types).toContain('/index.d.ts');
    }
  });

  it('keeps package ownership explicit across Web and CLI imports', () => {
    const frameworkBuild = JSON.parse(
      readFileSync(resolve(frameworkRoot, 'tsconfig.build.json'), 'utf8')
    ) as { include: string[] };
    expect(frameworkBuild.include).toEqual(['src/**/*.ts']);
    assertWebImports(webBrowserSourceFiles(), 'browser');
    assertWebImports([resolve(root, 'apps/web/vite.config.ts')], 'vite');
    for (const cliFile of ts.sys.readDirectory(resolve(root, 'apps/cli/src'), ['.ts'], undefined, [
      '**/*.ts',
    ])) {
      expect(importsOf(cliFile).filter((specifier) => specifier.startsWith('@zen/'))).toEqual(
        expect.arrayContaining(['@zen/framework/node', '@zen/framework/product'])
      );
    }
  });

  it('keeps Web independent from ZenX implementation sources and browser demos', () => {
    const webFiles = webBrowserSourceFiles();
    const webSpecifiers = webFiles.flatMap((path) => importsOf(path));
    expect(webSpecifiers.some((specifier) => specifier.includes('apps/zenx'))).toBe(false);
    expect(webFiles.some((path) => path.endsWith('demo-app-server.ts'))).toBe(false);

    const workspace = readFileSync(resolve(root, 'apps/web/src/workspace.tsx'), 'utf8');
    expect(workspace).not.toMatch(/mode=demo|createBrowserDemoAppServer|RuntimeMode/u);
  });

  it('publishes the desktop bridge contract from presentation', () => {
    const presentation = readFileSync(resolve(sourceRoot, 'presentation/index.ts'), 'utf8');
    const bridge = readFileSync(resolve(sourceRoot, 'presentation/desktop-bridge.ts'), 'utf8');
    const ipc = readFileSync(resolve(root, 'apps/zenx/src/ipc.ts'), 'utf8');
    const desktopDeclaration = readFileSync(resolve(root, 'apps/web/src/desktop.d.ts'), 'utf8');

    expect(presentation).toContain("'./desktop-bridge.js'");
    expect(bridge).toMatch(/export type DesktopNotification/u);
    expect(bridge).toMatch(/export type ZenDesktopBridge/u);
    expect(ipc).toContain("'@zen/framework/presentation'");
    expect(desktopDeclaration).toContain("'@zen/framework/presentation'");
    expect(desktopDeclaration).not.toContain('apps/zenx/src');
  });

  it('rejects direct framework implementation imports from Web code', () => {
    expect(() =>
      assertWebSpecifiers(['../../../packages/framework/src/adapters/node/index.js'], 'browser')
    ).toThrow('must not reference a physical framework src path');
  });

  it('keeps the removed single-project remote protocol out of public entrypoints', () => {
    const product = readFileSync(resolve(sourceRoot, 'product/index.ts'), 'utf8');
    const node = readFileSync(resolve(sourceRoot, 'adapters/node/index.ts'), 'utf8');
    const presentation = readFileSync(resolve(sourceRoot, 'presentation/index.ts'), 'utf8');
    const removedNames = [
      'AppServerRequest',
      'AppServerResponse',
      'AppServerNotification',
      'AppServerClient',
      'HttpAppServerClient',
      'serveAppServerHttpTransport',
      'applyAppServerNotification',
    ];

    for (const name of removedNames) {
      const exactName = new RegExp(`\\b${name}\\b`, 'u');
      expect(product).not.toMatch(exactName);
      expect(node).not.toMatch(exactName);
      expect(presentation).not.toMatch(exactName);
    }

    for (const path of sourceFiles().filter((path) => groupFor(path) === 'presentation')) {
      expect(importsOf(path)).not.toContain('../product/app-server.js');
      expect(importsOf(path)).not.toContain('../product/app-server-protocol.js');
      expect(importsOf(path)).not.toContain('../adapters/node/app-server-transport.js');
    }
  });
});

function isInternalLegacyRuntimeImport(from: Group, to: Group, specifier: string): boolean {
  return (
    to === 'product' &&
    from === 'adapters/node' &&
    /^\.\.\/.*product\/(app-server|app-server-protocol)\.js$/u.test(specifier)
  );
}

function sourceFiles(): readonly string[] {
  return groups.flatMap((group) =>
    ts.sys.readDirectory(resolve(sourceRoot, group), ['.ts'], undefined, ['**/*.ts'])
  );
}

function webBrowserSourceFiles(): readonly string[] {
  return ts.sys.readDirectory(resolve(root, 'apps/web/src'), ['.ts', '.tsx'], undefined, [
    '**/*.ts',
    '**/*.tsx',
  ]);
}

function assertWebImports(paths: readonly string[], kind: 'browser' | 'vite'): void {
  for (const path of paths) assertWebSpecifiers(importsOf(path), kind);
}

function assertWebSpecifiers(specifiers: readonly string[], kind: 'browser' | 'vite'): void {
  const allowed =
    kind === 'browser'
      ? ['@zen/framework/product', '@zen/framework/presentation']
      : ['@zen/framework/node'];
  for (const specifier of specifiers) {
    if (specifier.includes('packages/framework/src')) {
      throw new Error(
        `Web ${kind} import must not reference a physical framework src path: ${specifier}`
      );
    }
    if (specifier.startsWith('@zen/framework') && !allowed.includes(specifier)) {
      throw new Error(`Web ${kind} import uses an unapproved framework entrypoint: ${specifier}`);
    }
  }
}

function importsOf(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const values: string[] = [];
  source.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      values.push(node.moduleSpecifier.text);
    }
  });
  return values;
}

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(from, '..');
  for (const candidate of [
    resolve(base, specifier),
    resolve(base, specifier.replace(/\.js$/u, '.ts')),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function groupFor(path: string): Group {
  const relative = path.slice(sourceRoot.length + 1).replaceAll('\\', '/');
  return groups.find((group) => relative === group || relative.startsWith(`${group}/`)) ?? 'kernel';
}
