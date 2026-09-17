#!/usr/bin/env node
import { runClient } from "../src/entry.ts";

const code = await runClient(process.argv.slice(2));
process.exit(code);
