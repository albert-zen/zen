// Source-mode Host only. Packaged Hosts use the compiled Worker directly.
import { tsImport } from "tsx/esm/api";

await tsImport("../../../../src/code-runtime-worker.ts", import.meta.url);
