import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const webOutput = resolve(import.meta.dirname, '..', '..', 'web', 'dist');
const desktopWebOutput = resolve(import.meta.dirname, '..', 'dist', 'web');

await cp(webOutput, desktopWebOutput, { recursive: true });
