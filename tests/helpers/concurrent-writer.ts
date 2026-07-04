// T0.4 并发测试的子进程写入器：bun concurrent-writer.ts <dbPath> <count> <tag>
import { openDb } from "../../src/db";
import { appendSituation } from "../../src/situation";

const [dbPath, countStr, tag] = process.argv.slice(2);
if (!dbPath || !countStr || !tag) {
  console.error("usage: bun concurrent-writer.ts <dbPath> <count> <tag>");
  process.exit(1);
}

const db = openDb(dbPath);
const n = parseInt(countStr, 10);
for (let i = 0; i < n; i++) {
  appendSituation(db, { sessionId: tag, kind: "concurrency_probe", payload: { i } });
}
