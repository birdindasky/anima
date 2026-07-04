// FINAL grader's own multi-process CAS racer (independent of repo helpers).
// Opens the same WAL db, races the SAME watermark segment via storeSelfReviewResult.
// Prints exactly "WON" or "LOST" to stdout. Any crash → nonzero exit + stderr.
// usage: bun final-cas-racer.ts <dbPath> <sessionId> <oldUuid|null> <newUuid> <tag>
import { openDb } from "../../src/db";
import { storeSelfReviewResult, type GeneratedSelfReview, type Material } from "../../src/selfReview";

const [dbPath, sessionId, oldUuidArg, newUuid, tag] = process.argv.slice(2);
if (!dbPath || !sessionId || oldUuidArg === undefined || !newUuid) {
  process.stderr.write("usage: final-cas-racer.ts <dbPath> <sessionId> <oldUuid|null> <newUuid> <tag>\n");
  process.exit(2);
}
const oldUuid = oldUuidArg === "null" ? null : oldUuidArg;

const material: Material = {
  sessionId,
  project: "p",
  conversation: [`用户：racer ${tag} 抢同一段水位线`],
  events: [],
  bookmarks: [],
  evidenceText: `racer ${tag} 抢同一段水位线`,
};
const generated: GeneratedSelfReview = {
  ok: true,
  attempts: 1,
  value: {
    review: `racer ${tag} 推到 ${newUuid} 的增量复盘文本，写得够长够具体，绝不空洞。`,
    feeling: "",
    intensity: "",
    keywords: ["race", tag ?? "x"],
    items: [],
  },
};

try {
  const db = openDb(dbPath);
  const r = storeSelfReviewResult(db, generated, { material, advanceWatermark: { oldUuid, newUuid, entries: null } });
  db.close();
  process.stdout.write(r.lostRace ? "LOST" : "WON");
} catch (e) {
  process.stderr.write(`CRASH ${(e as Error).message}\n`);
  process.exit(1);
}
