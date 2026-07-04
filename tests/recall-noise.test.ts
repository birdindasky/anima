// AUDIT-2026-07-01 盘点两刀（字面检索噪音）红灯先行：
//   U27 整句自然语言查询被填充词稀释：bigram 单元里混进 为什么/那个/的… 抬高分母，
//       >50% 覆盖率门槛把真命中判漏召（已复现）。修＝segmentQuery 查询侧停用词剥离。
//   U38 listReceiptsChrono 软筛对整串 JSON payload 做 LIKE：查询词撞 JSON 键名
//       （command/path/text）假命中，软筛形同虚设。修＝按 kind 取正文字段（同 chronoReceiptLine 口径）。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { insertExperience, searchExperiences, segmentQuery } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { listReceiptsChrono } from "../src/recall";
import { frozenClock } from "../src/clock";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-noise-${process.pid}-${n++}.db`));
const clock = frozenClock("2026-06-13T09:00:00.000Z");

describe("U27 segmentQuery 停用词剥离（查询侧）", () => {
  test("整句问带填充词仍能召回：为什么…那个…会…", () => {
    const db = freshDb();
    const row = insertExperience(
      db,
      {
        kind: "self_review",
        project: "anima",
        content: "迁移静默吞错：bun:sqlite exec 多语句某条失败不抛错，半截迁移被记成完成版本还推进。",
        sourceSession: "s1",
      },
      clock,
    );
    const ids = searchExperiences(db, "为什么那个迁移会静默失败", { project: "anima" }).map((r) => r.id);
    expect(ids).toContain(row.id);
  });

  test("整句问带填充词仍能召回：怎么…的…问题", () => {
    const db = freshDb();
    const row = insertExperience(
      db,
      {
        kind: "self_review",
        project: "anima",
        content: "水位线 CAS 防回退：casWatermark 拒绝把 last_uuid 推回更早位置。",
        sourceSession: "s1",
      },
      clock,
    );
    const ids = searchExperiences(db, "怎么修的水位线回退问题", { project: "anima" }).map((r) => r.id);
    expect(ids).toContain(row.id);
  });

  test("零误伤：无填充词的精确技术查询切分不变", () => {
    // dedup_key 走英文 token、唯一索引 走 bigram——都不含停用词，剥离层必须原样放行
    expect(segmentQuery("dedup_key 唯一索引")).toEqual(["dedup_key", "唯一", "一索", "索引"]);
  });

  test("零误伤：两字中文词整词保留（不在长句里就不动它）", () => {
    // 会/了 这类语法字只在 ≥3 字连写段里剥；独立两字词（会话/了解）是用户给的精确词，原样保留
    expect(segmentQuery("会话")).toEqual(["会话"]);
    expect(segmentQuery("了解")).toEqual(["了解"]);
  });

  test("纯停用词查询回退原切分，绝不空手", () => {
    const units = segmentQuery("为什么");
    expect(units.length).toBeGreaterThan(0);
  });

  test("英文停用词整 token 剥离：how to fix 不稀释", () => {
    const db = freshDb();
    const row = insertExperience(
      db,
      {
        kind: "self_review",
        project: "anima",
        content: "fix watermark rollback guard in casWatermark",
        sourceSession: "s1",
      },
      clock,
    );
    const ids = searchExperiences(db, "how to fix the watermark rollback", { project: "anima" }).map(
      (r) => r.id,
    );
    expect(ids).toContain(row.id);
  });
});

describe("U38 listReceiptsChrono 软筛按 kind 正文字段（不再整串 JSON LIKE）", () => {
  const SINCE = "2026-06-12T16:00:00.000Z";
  const UNTIL = "2026-06-13T16:00:00.000Z";
  const seed = (db: ReturnType<typeof freshDb>) => {
    appendSituation(
      db,
      {
        kind: "command_run",
        project: "/proj",
        payload: { command: "bun test tests/recall.test.ts", ok: true },
        occurredAt: "2026-06-13T05:00:00.000Z",
      },
      clock,
    );
    appendSituation(
      db,
      {
        kind: "file_read",
        project: "/proj",
        payload: { path: "/Users/x/notes/设计稿.md" },
        occurredAt: "2026-06-13T06:00:00.000Z",
      },
      clock,
    );
    appendSituation(
      db,
      {
        kind: "user_message",
        project: "/proj",
        payload: { text: "把水位线回退的护栏补上" },
        occurredAt: "2026-06-13T07:00:00.000Z",
      },
      clock,
    );
  };

  test("查询词=JSON 键名不再假命中（command/path/text 撞键名）", () => {
    const db = freshDb();
    seed(db);
    for (const q of ["command", "path", "text"]) {
      const rows = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj", query: q });
      expect(rows).toEqual([]);
    }
  });

  test("正文字段照常命中：命令/路径/原话各走各的字段", () => {
    const db = freshDb();
    seed(db);
    const byCmd = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj", query: "bun test" });
    expect(byCmd.length).toBe(1);
    expect(byCmd[0]!.line).toContain("bun test");

    const byPath = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj", query: "设计稿" });
    expect(byPath.length).toBe(1);
    expect(byPath[0]!.line).toContain("设计稿");

    const byText = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj", query: "水位线" });
    expect(byText.length).toBe(1);
    expect(byText[0]!.line).toContain("水位线");
  });

  test("JSON 结构字符不假命中（花括号/引号这类 payload 骨架）", () => {
    const db = freshDb();
    seed(db);
    const rows = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj", query: "ok" });
    // "ok":true 是 command_run payload 的键值骨架，不是正文——不该命中任何行
    expect(rows).toEqual([]);
  });
});
