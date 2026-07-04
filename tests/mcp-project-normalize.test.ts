// AUDIT-2026-06-29 缺口#2 + AUDIT-2026-07-01 rank2 红灯回归：MCP 边界 project 读写两端归一化。
// 缺口#2：内部 3 个写点都 normalizeProject 把 cwd 归卷项目根；MCP（书签写 / recall / recall_detail）过去直接
//   拿模型传的原始路径 → 深子目录路径与库里归一化标签匹配不上＝与自己项目脱钩。修：MCP 两端同样归一化。
// rank2 回归（本轮对抗测试临时库真复现）：读侧 `normalizeProject(raw) ?? undefined` 把「传了但认不出的
//   项目串」（~/、裸名、相对、/tmp）塌成 undefined＝无墙＝搜全库/跨项目泄露，比不归一化更糟（原来字面串进墙
//   还能不匹配挡住）。修：认不出 → fail-closed 到「仅全局」哨兵（READ_GLOBAL_ONLY），绝不塌成 undefined。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { addBookmark } from "../src/bookmark";
import { appendSituation } from "../src/situation";
import { resolveRecallArgs, renderMemoryDetail, searchMemoryIndex } from "../src/recall";
import { mcpProjectForRead, mcpProjectForWrite } from "../src/project";

const HOME = "/home/tester"; // 固定 home，测试与机器无关
const ROOT = `${HOME}/Projects/anima`;
const DEEP_A = `${HOME}/Projects/anima/src/deep`; // 写书签时的深子目录
const DEEP_B = `${HOME}/Projects/anima/exam/ultimate`; // 另一处深子目录，同项目
const OTHER = `${HOME}/Projects/secretproj`; // 另一个真实项目（跨项目泄露的源）
const clock = frozenClock("2026-06-30T04:00:00Z");

// 认不出的项目串：normalizeProject 只认真实绝对路径 `<home>/Projects/<name>`，下面这些都 → null
const UNRESOLVABLE = ["~/Projects/mine", "mine", "Projects/mine", "/tmp/mine"];

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-mcpproj-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("MCP project 归一化（缺口#2）", () => {
  test("mcpProjectForWrite：深子目录归卷项目根；非-Projects/空 → null（全局）", () => {
    expect(mcpProjectForWrite(DEEP_A, HOME)).toBe(ROOT);
    expect(mcpProjectForWrite(ROOT, HOME)).toBe(ROOT); // 已是根 → 不变
    expect(mcpProjectForWrite("/tmp/whatever", HOME)).toBeNull(); // 非 Projects → null
    expect(mcpProjectForWrite(null, HOME)).toBeNull();
    expect(mcpProjectForWrite(123, HOME)).toBeNull(); // 非字符串
  });

  test("mcpProjectForRead：没传 → undefined（搜全部）；深子目录 → 项目根；认不出 → 仅全局哨兵（绝非 undefined）", () => {
    expect(mcpProjectForRead(undefined, HOME)).toBeUndefined(); // 省略=搜全部
    expect(mcpProjectForRead(123, HOME)).toBeUndefined(); // 非字符串=省略
    expect(mcpProjectForRead(DEEP_B, HOME)).toBe(ROOT); // 深子目录 → 归卷项目根
    // rank2：认不出的项目串必须 fail-closed（返回一个非 undefined 的串＝加墙仅全局），绝不塌成 undefined（=无墙）
    for (const raw of UNRESOLVABLE) {
      const r = mcpProjectForRead(raw, HOME);
      expect(r).not.toBeUndefined();
      expect(typeof r).toBe("string");
    }
  });

  test("命门端到端：深路径 A 写的书签，能被同项目另一深路径 B 召回（归一化后对上）", () => {
    const db = tmpDb();
    addBookmark(db, { content: "深路径写的书签 NEEDLE7788", project: mcpProjectForWrite(DEEP_A, HOME) }, clock);
    const hitNorm = searchMemoryIndex(db, "NEEDLE7788", { project: mcpProjectForRead(DEEP_B, HOME), clock });
    expect(hitNorm.some((l) => l.line.includes("NEEDLE7788"))).toBe(true);
    // 对照（旧行为=不归一化）：拿原始深路径 B 当 project → 与存的项目根对不上 → 找不到（正是缺口#2 的病）
    const hitRaw = searchMemoryIndex(db, "NEEDLE7788", { project: DEEP_B, clock });
    expect(hitRaw.some((l) => l.line.includes("NEEDLE7788"))).toBe(false);
  });

  test("recall_detail：归一化后深路径 project 能拉到同项目记忆的全文", () => {
    const db = tmpDb();
    const bm = addBookmark(db, { content: "全文内容 FULLTEXT9911", project: mcpProjectForWrite(DEEP_A, HOME) }, clock);
    const detail = renderMemoryDetail(db, "experience", bm.id, { clock, project: mcpProjectForRead(DEEP_B, HOME) });
    expect(detail).toContain("FULLTEXT9911");
  });

  // ── rank2 红灯：认不出的项目串不得跨项目泄露（fail-closed 到「仅全局」，而非无墙搜全库）────────────────
  describe("rank2 回归：认不出项目串 fail-closed，不泄露别项目、但仍返回全局", () => {
    function seedOtherProjectSituation(db: Database): number {
      // 别项目 OTHER 的敏感动作小票（#s command_run，含 secret）
      const s = appendSituation(
        db,
        { project: OTHER, kind: "command_run", payload: { command: "SECRET-B-DEPLOY --token xyz", category: "deploy" } },
        clock,
      );
      return s.id;
    }

    test("recall_detail：用 ~/裸名/相对//tmp 等认不出的 project 拉别项目 #s 动作 → 不泄露（返 null）", () => {
      for (const raw of UNRESOLVABLE) {
        const db = tmpDb();
        const leakId = seedOtherProjectSituation(db);
        // WIP 前：mcpProjectForRead(raw)→undefined→无墙→WHERE id=?→泄露 SECRET；修后：哨兵→仅全局→别项目不返
        const detail = renderMemoryDetail(db, "situation", leakId, { clock, project: mcpProjectForRead(raw, HOME) });
        expect(detail).toBeNull();
      }
    });

    test("recall 索引：认不出的 project 不把别项目记忆搜出来，但全局记忆仍返回（仅全局≠啥都不返）", () => {
      const db = tmpDb();
      addBookmark(db, { content: "SECRET-OTHER-XKCD 别项目私货", project: OTHER }, clock); // 别项目经历
      addBookmark(db, { content: "GLOBAL-SHARED-XKCD 全局便签", project: null }, clock); // 全局经历
      // 走 server.ts 真实读路：resolveRecallArgs 先吃预归一化的 project，再进 searchMemoryIndex
      const { query, opts } = resolveRecallArgs(
        { query: "XKCD", project: mcpProjectForRead("~/Projects/mine", HOME) },
        clock,
      );
      const blob = searchMemoryIndex(db, query, opts)
        .map((l) => l.line)
        .join("\n");
      expect(blob).not.toContain("SECRET-OTHER"); // 别项目不越墙
      expect(blob).toContain("GLOBAL-SHARED"); // 仅全局仍返回，fail-closed 不是全灭
    });
  });
});
