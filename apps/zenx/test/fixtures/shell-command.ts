export function shellPrintCommand(text: string): string {
  if (!/^[A-Za-z0-9-]+$/u.test(text)) {
    throw new Error("shell print fixture only accepts portable literal text");
  }
  return `${JSON.stringify(process.execPath)} -e "process.stdout.write('${text}')"`;
}
