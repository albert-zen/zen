#!/usr/bin/env node
import { createProviderBackedAppServer } from '../adapters/node/index.js';
import { runTui } from './tui.js';

await runTui({ client: await createProviderBackedAppServer({ cwd: process.cwd() }) });
