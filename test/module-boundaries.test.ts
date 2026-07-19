import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
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
      const imports = importsOf(sourceFile);

      for (const specifier of imports) {
        if (!specifier.startsWith('.')) continue;
        const target = resolveModule(sourceFile, specifier);
        if (!target || !target.startsWith(resolve(root, 'src'))) continue;
        const to = groupFor(target);
        expect(allowed[from]).toContain(to);
        if (from !== to && !isInternalLegacyRuntimeImport(from, to, specifier)) {
          expect(specifier).toMatch(/index\.js$/u);
        }
      }
    }
  });

  it('keeps the root package surface kernel-only and publishes all group subpaths', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
    };
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

  it('keeps acceptance outside production declarations and Web imports on approved aliases', () => {
    const build = JSON.parse(readFileSync(resolve(root, 'tsconfig.build.json'), 'utf8')) as {
      exclude: string[];
    };
    expect(build.exclude).toContain('acceptance/**/*.ts');
    assertWebImports(webBrowserSourceFiles(), 'browser');
    assertWebImports([resolve(root, 'web/vite.config.ts')], 'vite');
  });

  it('rejects a direct adapter implementation import from Web code', () => {
    expect(() =>
      assertWebSpecifiers(['../src/adapters/node/app-server-transport.js'], 'browser')
    ).toThrow('must not reference a physical src path');
  });

  it('keeps the removed single-project remote protocol out of public entrypoints', () => {
    const product = readFileSync(resolve(root, 'src/product/index.ts'), 'utf8');
    const node = readFileSync(resolve(root, 'src/adapters/node/index.ts'), 'utf8');
    const presentation = readFileSync(resolve(root, 'src/presentation/index.ts'), 'utf8');
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
    ts.sys.readDirectory(resolve(root, 'src', group), ['.ts'], undefined, ['**/*.ts'])
  );
}

function webBrowserSourceFiles(): readonly string[] {
  return ts.sys.readDirectory(resolve(root, 'web/src'), ['.ts', '.tsx'], undefined, [
    '**/*.ts',
    '**/*.tsx',
  ]);
}

function assertWebImports(paths: readonly string[], kind: 'browser' | 'vite'): void {
  for (const path of paths) assertWebSpecifiers(importsOf(path), kind);
}

function assertWebSpecifiers(specifiers: readonly string[], kind: 'browser' | 'vite'): void {
  for (const specifier of specifiers) {
    if (specifier.includes('/src/') || specifier.startsWith('../src/')) {
      throw new Error(`Web ${kind} import must not reference a physical src path: ${specifier}`);
    }
    if (specifier.startsWith('#zen/')) {
      const allowedAliases =
        kind === 'browser' ? ['#zen/product', '#zen/presentation'] : ['#zen/node'];
      if (!allowedAliases.includes(specifier)) {
        throw new Error(`Web ${kind} import uses an unapproved Zen alias: ${specifier}`);
      }
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
    )
      values.push(node.moduleSpecifier.text);
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
  const relative = path.slice(resolve(root, 'src').length + 1).replaceAll('\\', '/');
  return groups.find((group) => relative === group || relative.startsWith(`${group}/`)) ?? 'kernel';
}
