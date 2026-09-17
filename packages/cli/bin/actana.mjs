#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distEntry = join(root, "../dist/entry.js");
const devEntry = join(root, "../src/entry.ts");

const entry = existsSync(distEntry) ? distEntry : devEntry;
const { runClient } = await import(pathToFileURL(entry).href);
const code = await runClient(process.argv.slice(2));
process.exit(code);
