// Install-time DB bootstrap: create the anima database (schema migrations included) so that
// read-only tools (whoami) and the first session hooks find a ready store.
// Idempotent: openDb migrates an existing DB forward or no-ops if already current.
import { resolveConfig } from "../src/config";
import { openDb } from "../src/db";

const config = resolveConfig();
const db = openDb(config.dbPath);
db.close();
console.log(`[anima] database ready: ${config.dbPath}`);
