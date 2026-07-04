// DESIGN-WORK-TIMELINE §2/§3A：日记层（蒸馏 experiences）按时间查。
// 时间窗 [sinceTs, untilTs) 左闭右开；按 occurred_at DESC 排（order_seq 未落→tie-break 用 id，绝不 COALESCE 死列）；
// 排除 self_review_fallback；默认排除失效；project 墙；query 可空（空=窗内全取，非空=OR 软筛、不套覆盖率门槛）。
// 红灯先行：实现前 experiences.ts 无 searchExperiencesChrono 导出。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { insertExperience, searchExperiencesChrono } from "../src/experiences";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-expchrono-${process.pid}-${n++}.db`));
const SINCE = "2026-06-12T16:00:00.000Z";
const UNTIL = "2026-06-13T16:00:00.000Z";
const ins = (db: any, o: any) =>
  insertExperience(db, { feeling: null, keywords: [], ...o });

describe("searchExperiencesChrono（日记层时间线）", () => {
  test("时间窗左闭右开 + 按 occurred_at DESC（不随 id 倒挂）", () => {
    const db = freshDb();
    // P 先插（id 小）occurredAt 晚；Q 后插（id 大）occurredAt 早 → occurred_at DESC 应 [P,Q]
    const P = ins(db, { sessionId: "s", project: "/p", kind: "work_action", content: "换 YAML 配置", occurredAt: "2026-06-13T05:00:00.000Z" });
    const Q = ins(db, { sessionId: "s", project: "/p", kind: "work_action", content: "跑迁移", occurredAt: "2026-06-13T01:00:00.000Z" });
    ins(db, { sessionId: "s", project: "/p", kind: "work_action", content: "窗外早", occurredAt: "2026-06-12T15:00:00.000Z" }); // < since 排除
    ins(db, { sessionId: "s", project: "/p", kind: "work_action", content: "窗外恰 until", occurredAt: UNTIL }); // = until 排除（右开）
    const rows = searchExperiencesChrono(db, "", { sinceTs: SINCE, untilTs: UNTIL, project: "/p" });
    expect(rows.map((r) => r.id)).toEqual([P.id, Q.id]); // 窗内 2 条、occurred_at DESC
  });

  test("排除 self_review_fallback（壳不进时间线）", () => {
    const db = freshDb();
    ins(db, { sessionId: "s", project: "/p", kind: "self_review", content: "真复盘", occurredAt: "2026-06-13T03:00:00.000Z" });
    ins(db, { sessionId: "s", project: "/p", kind: "self_review_fallback", content: "自评生成失败N次", occurredAt: "2026-06-13T03:30:00.000Z" });
    const rows = searchExperiencesChrono(db, "", { sinceTs: SINCE, untilTs: UNTIL, project: "/p" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toContain("真复盘");
  });

  test("project 墙 + includeGlobal", () => {
    const db = freshDb();
    ins(db, { sessionId: "s", project: "/mine", kind: "work_action", content: "我的", occurredAt: "2026-06-13T03:00:00.000Z" });
    ins(db, { sessionId: "s", project: "/other", kind: "work_action", content: "别人的", occurredAt: "2026-06-13T03:00:00.000Z" });
    ins(db, { sessionId: "s", project: null, kind: "work_action", content: "全局的", occurredAt: "2026-06-13T03:00:00.000Z" });
    const rows = searchExperiencesChrono(db, "", { sinceTs: SINCE, untilTs: UNTIL, project: "/mine", includeGlobal: true });
    const c = rows.map((r) => r.content).join("|");
    expect(c).toContain("我的");
    expect(c).toContain("全局的");
    expect(c).not.toContain("别人的");
  });

  test("query 可空=窗内全取；非空=OR 软筛（不套覆盖率门槛）", () => {
    const db = freshDb();
    ins(db, { sessionId: "s", project: "/p", kind: "work_action", content: "换 YAML 配置格式", keywords: ["YAML"], occurredAt: "2026-06-13T02:00:00.000Z" });
    ins(db, { sessionId: "s", project: "/p", kind: "work_action", content: "重构登录", occurredAt: "2026-06-13T04:00:00.000Z" });
    expect(searchExperiencesChrono(db, "", { sinceTs: SINCE, untilTs: UNTIL, project: "/p" }).length).toBe(2);
    const yaml = searchExperiencesChrono(db, "YAML", { sinceTs: SINCE, untilTs: UNTIL, project: "/p" });
    expect(yaml.length).toBe(1);
    expect(yaml[0]!.content).toContain("YAML");
  });
});
