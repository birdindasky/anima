// 真并发压测子进程：开同一个库、对同一 session 抢同一段水位线 CAS。
// 赢（写了自评+推水位线）印 "WON"，输（lostRace）印 "LOST"。
// 用法：bun cas-racer.ts <dbPath> <sessionId> <oldUuid|null> <newUuid>
import { openDb } from "../../src/db";
import { storeSelfReviewResult, type GeneratedSelfReview, type Material } from "../../src/selfReview";

const [dbPath, sessionId, oldUuidArg, newUuid] = process.argv.slice(2);
if (!dbPath || !sessionId || oldUuidArg === undefined || !newUuid) {
  process.stderr.write("usage: cas-racer.ts <dbPath> <sessionId> <oldUuid|null> <newUuid>\n");
  process.exit(2);
}
const oldUuid = oldUuidArg === "null" ? null : oldUuidArg;

const material: Material = {
  sessionId,
  project: "p",
  conversation: ["用户：抢同一段水位线"],
  events: [],
  bookmarks: [],
  evidenceText: "抢同一段水位线",
};
const generated: GeneratedSelfReview = {
  ok: true,
  attempts: 1,
  value: { review: `racer ${newUuid} 的增量复盘文本够长够具体`, feeling: "", intensity: "", keywords: ["race"], items: [] },
};

const db = openDb(dbPath);
const r = storeSelfReviewResult(db, generated, {
  material,
  advanceWatermark: { oldUuid, newUuid, entries: null },
});
db.close();
process.stdout.write(r.lostRace ? "LOST" : "WON");
