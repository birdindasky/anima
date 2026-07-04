// FINAL grader's cold-start concurrent opener: open a (possibly brand-new) db, do a
// trivial write, read schema_version, print "OK v<N>" or crash with nonzero exit.
// usage: bun final-cold-opener.ts <dbPath> <tag>
import { openDb } from "../../src/db";
import { appendSituation } from "../../src/situation";

const [dbPath, tag] = process.argv.slice(2);
if (!dbPath || !tag) {
  process.stderr.write("usage: final-cold-opener.ts <dbPath> <tag>\n");
  process.exit(2);
}
try {
  const db = openDb(dbPath);
  appendSituation(db, { sessionId: `cold-${tag}`, kind: "user_message", payload: { tag } });
  const v = (db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
  db.close();
  process.stdout.write(`OK v${v}`);
} catch (e) {
  process.stderr.write(`CRASH ${(e as Error).message}\n`);
  process.exit(1);
}
