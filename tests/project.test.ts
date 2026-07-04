// project 标签归一化：cwd → 项目根 / null。两个老毛病——home 污染、深子目录不归卷——的回归护栏。
import { describe, expect, test } from "bun:test";
import { normalizeProject } from "../src/project";

const HOME = "/Users/tester"; // 固定 home，确定性（不依赖跑测机器的真实 home）
const np = (cwd: string | null | undefined) => normalizeProject(cwd, HOME);

describe("normalizeProject", () => {
  test("项目根：原样保留（幂等）", () => {
    expect(np("/Users/tester/Projects/anima")).toBe("/Users/tester/Projects/anima");
    expect(np("/Users/tester/Projects/acme-app")).toBe("/Users/tester/Projects/acme-app");
    // 幂等：归一结果再喂回去不变（回填安全的前提）
    expect(np(np("/Users/tester/Projects/anima"))).toBe("/Users/tester/Projects/anima");
  });

  test("深子目录：归卷到项目根（治毛病②）", () => {
    expect(np("/Users/tester/Projects/acme-app/deploy/sub/dir")).toBe(
      "/Users/tester/Projects/acme-app",
    );
    expect(np("/Users/tester/Projects/anima/exam")).toBe("/Users/tester/Projects/anima");
    expect(np("/Users/tester/Projects/art-studio/.claude/worktrees/x")).toBe(
      "/Users/tester/Projects/art-studio",
    );
  });

  test("home 本身 → null（治毛病①：1282 条 home 污染）", () => {
    expect(np("/Users/tester")).toBeNull();
  });

  test("~/.claude 及其它非项目目录 → null", () => {
    expect(np("/Users/tester/.claude")).toBeNull();
    expect(np("/Users/tester/.claude/anima")).toBeNull();
    expect(np("/Users/tester/.claude/anima-ab-sealed/v2")).toBeNull();
    expect(np("/Users/tester/Downloads")).toBeNull();
  });

  test("Projects 裸目录（无项目名）→ null", () => {
    expect(np("/Users/tester/Projects")).toBeNull();
    expect(np("/Users/tester/Projects/")).toBeNull();
  });

  test("空 / null / undefined → null", () => {
    expect(np(null)).toBeNull();
    expect(np(undefined)).toBeNull();
    expect(np("")).toBeNull();
  });

  test("不吞「Projects」前缀的兄弟目录（Projectsfoo ≠ Projects/）", () => {
    expect(np("/Users/tester/Projectsfoo/bar")).toBeNull();
  });

  test("默认用真实 home 时也不炸（只验不抛、外部路径归 null）", () => {
    expect(normalizeProject("/some/where/else")).toBeNull();
    expect(normalizeProject(null)).toBeNull();
  });
});
