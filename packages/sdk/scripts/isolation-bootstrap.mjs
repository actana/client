import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(root, "isolation-hook.mjs")).href, import.meta.url);
