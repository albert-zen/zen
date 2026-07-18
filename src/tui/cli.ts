#!/usr/bin/env node
import { createLegacyTuiClient } from '../adapters/node/index.js';
import { runTui } from './tui.js';

await runTui({ client: await createLegacyTuiClient(process.cwd()) });
