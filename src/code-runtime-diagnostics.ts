import { parse } from "acorn";

interface Position {
  line: number;
  column: number;
}

/** Only user-code locations are shown; internal frames never leave the worker. */
export function formatCodeDiagnostic(
  source: string,
  message: string,
  stack = "",
): string {
  const match = /^\s*at (?:.*\()?run_code:(\d+):(\d+)\)?\s*$/m.exec(stack);
  return match === null
    ? message
    : withPosition(source, message, {
        line: Number(match[1]),
        column: Number(match[2]),
      });
}

/** V8 accepts/rejects the program first. Acorn is only a location fallback. */
export function formatCodeSyntaxDiagnostic(
  source: string,
  message: string,
): string {
  try {
    parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
  } catch (error) {
    const location = (error as { loc?: { line: number; column: number } }).loc;
    if (location)
      return withPosition(source, message, {
        line: location.line,
        column: location.column + 1,
      });
  }
  return message;
}

export function formatCodeImportDiagnostic(
  source: string,
  specifier: string,
  message: string,
): string {
  try {
    const program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
    const declaration = program.body.find(
      (node) =>
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source?.value === specifier,
    );
    if (declaration?.loc)
      return withPosition(source, message, {
        line: declaration.loc.start.line,
        column: declaration.loc.start.column + 1,
      });
  } catch {
    /* New V8 syntax may exceed the diagnostic parser's grammar. */
  }
  return message;
}

function withPosition(
  source: string,
  message: string,
  position: Position,
): string {
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/);
  const line = lines[position.line - 1];
  if (
    line === undefined ||
    position.column < 1 ||
    position.column > line.length + 1
  )
    return message;
  const start = Math.max(0, position.column - 1 - 80);
  const end = Math.min(line.length, start + 160);
  const prefix = start > 0 ? "…" : "";
  const snippet =
    prefix + line.slice(start, end) + (end < line.length ? "…" : "");
  const caret =
    prefix.replace(/./g, " ") +
    line.slice(start, position.column - 1).replace(/[^\t]/g, " ") +
    "^";
  return `${message}\nrun_code:${position.line}:${position.column}\n${snippet}\n${caret}`;
}
