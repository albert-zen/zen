export function shellPrintCommand(text: string): string {
  if (!/^[A-Za-z0-9-]+$/u.test(text)) {
    throw new Error("shell print fixture only accepts portable literal text");
  }
  return `${JSON.stringify(process.execPath)} -e "process.stdout.write('${text}')"`;
}

export function png1x1(): Uint8Array {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}
