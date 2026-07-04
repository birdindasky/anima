// 独立验收考官 · AUDIT-2026-07-02 刀A（U27 整句召回 + U38 小票软筛）。
// 我不改 src/、不碰生产库；每个用例临时目录建库。测试对抗性设计——专攻边界与误伤。
// 结论见团队回复：U27 核心召回 + U38 全过；U27 零回归有一处真缺陷（中缀停用字打散精确中文术语→过度召回），
// 下方 describe("U27 零回归缺陷…") 的用例是【断言正确行为→故意暴露缺陷】，会 FAIL，即复现证据。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { insertExperience, searchExperiences, segmentQuery } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { listReceiptsChrono } from "../src/recall";
import { frozenClock } from "../src/clock";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-grader0702a-${process.pid}-${n++}.db`));
const clock = frozenClock("2026-06-13T09:00:00.000Z");
const P = "anima";
const mk = (db: ReturnType<typeof freshDb>, content: string) =>
  insertExperience(db, { kind: "self_review", project: P, content, sourceSession: "s1" }, clock);
const ids = (db: ReturnType<typeof freshDb>, q: string) =>
  searchExperiences(db, q, { project: P }).map((r) => r.id);

// ───────────────────────── U27 核心：填充词稀释已修（召回不该再漏） ─────────────────────────
describe("U27 核心：整句自然语言查询召回", () => {
  test("头条例：'为什么那个迁移会静默失败' 召回迁移静默吞错记忆", () => {
    const db = freshDb();
    const row = mk(db, "迁移静默吞错：bun:sqlite exec 多语句某条失败不抛，半截迁移记成完成还推进");
    expect(ids(db, "为什么那个迁移会静默失败")).toContain(row.id);
  });

  test("填充词剥净、真实义词做 AND：'config.ts 为什么会失败' 只召回含 config.ts+失败 的", () => {
    const db = freshDb();
    const hit = mk(db, "config.ts 迁移失败了，yaml 解析炸");
    const miss = mk(db, "config.ts 改好了一切正常"); // 有 config.ts 无 失败
    const got = ids(db, "config.ts 为什么会失败");
    expect(got).toContain(hit.id);
    expect(got).not.toContain(miss.id); // 不因剥离退化成 config.ts 单词 OR
  });

  test("FTS 收窄路径×剥离：英文长单元+中文短单元混合仍召回（'casWatermark rollback 水位线'）", () => {
    // longUnits=[caswatermark,rollback] 触发 FTS MATCH；命中行只含 rollback+水位线（无 casWatermark），
    // 覆盖率仍达标且 FTS OR 命中 rollback → 不该被收窄漏掉
    const db = freshDb();
    const row = mk(db, "rollback guard 水位线回退防护，casWatermark 未出现");
    expect(ids(db, "casWatermark rollback 水位线")).toContain(row.id);
  });

  test("英文停用词整 token 剥：'what is WAL mode' 召回 WAL 记忆", () => {
    const db = freshDb();
    const row = mk(db, "WAL mode 打开：并发会话只追加不互改");
    expect(ids(db, "what is WAL mode")).toContain(row.id);
  });

  test("内容字面含'为什么'仍可被搜到，且'为什么'不退化成搜什么都命中", () => {
    const db = freshDb();
    const lit = mk(db, "记一笔：为什么那晚迁移失败没人知道");
    const unrel = mk(db, "水位线回退护栏"); // 不含 为什/什么
    const got = ids(db, "为什么");
    expect(got).toContain(lit.id); // ④ 回退切 [为什,什么] 命中字面
    expect(got).not.toContain(unrel.id); // 不是"搜什么都返回"
  });
});

// ───────────────────────── U27 零回归护栏（应保持） ─────────────────────────
describe("U27 零回归：2字词/专名/文件名/停用词回退/escape", () => {
  test("两字中文实义词整词保留（即便含停用字，如以停用字结尾的 性能/末字为的的 目的）", () => {
    expect(segmentQuery("会话")).toEqual(["会话"]);
    expect(segmentQuery("了解")).toEqual(["了解"]);
    expect(segmentQuery("目的")).toEqual(["目的"]);
    expect(segmentQuery("性能")).toEqual(["性能"]); // 能是停用字，但 2 字独立词不拆
  });

  test("专名/文件名整 token 不拆，大小写归一", () => {
    expect(segmentQuery("config.ts")).toEqual(["config.ts"]);
    expect(segmentQuery("src/db.ts")).toEqual(["src/db.ts"]);
    expect(segmentQuery("CONFIG.TS")).toEqual(["config.ts"]);
    expect(segmentQuery("dedup_key 唯一索引")).toEqual(["dedup_key", "唯一", "一索", "索引"]);
  });

  test("纯停用词查询绝不空手（否则=搜什么都搜不到）", () => {
    for (const q of ["为什么", "的", "the", "why", "还是"]) {
      expect(segmentQuery(q).length).toBeGreaterThan(0);
    }
  });

  test("escapeLike 保持：下划线是字面不是通配（experiences 路）", () => {
    const db = freshDb();
    const hit = mk(db, "dedup_key 单列唯一索引");
    const miss = mk(db, "dedupXkey 不该被下划线通配命中");
    const got = ids(db, "dedup_key");
    expect(got).toContain(hit.id);
    expect(got).not.toContain(miss.id);
  });

  test("独立2字词能召回含该词的记忆（长句/独立词两形态都不丢召回）", () => {
    const db = freshDb();
    const row = mk(db, "这个改动的目的是把水位线护栏补上");
    expect(ids(db, "目的")).toContain(row.id); // 独立词形态
    expect(ids(db, "这个改动的目的是啥")).toContain(row.id); // 长句形态（目的→目，子串仍命中）
  });
});

// ───────────────────────── U27 零回归缺陷：中缀停用字打散精确中文术语（应 FAIL） ─────────────────────────
// 根因单一：停用字 能/会/要 在 ≥3 字连写段里被当分隔符，把常见中文术语（性能/功能/主要/会话…）
// 打散成超高频单字残段（性/主…），required 用满剩余单元后，单字残段做 OR 子串匹配 → 拉进无关记忆，
// 甚至让噪音记忆排到真命中之上。这是查询侧剥离"过头"，正是团队 lead 要我核的"精确技术查询零回归"红线。
describe("U27 零回归缺陷：精确中文术语被中缀停用字打散→过度召回", () => {
  test("REGRESSION：'性能测试'（中文术语）不该召回无关的'个性化…单元测试'", () => {
    const db = freshDb();
    const real = mk(db, "性能测试报告：并发抬到10耗时降四成");
    // 干扰项含 性(个性) + 测试，但既无 性能 也无 能测 → 修前切 [性能,能测,测试] required2 只得1分被挡；
    // 修后切 [性,测试] required2 得2分被误召
    const distractor = mk(db, "个性化推荐的单元测试夹具改造");
    const got = ids(db, "性能测试");
    expect(got).toContain(real.id); // 召回没丢（这条仍成立）
    expect(got).not.toContain(distractor.id); // 但精确术语过度召回了无关记忆 → FAIL
  });

  test("REGRESSION：'性能测试' 的无关命中不该排在真命中之上", () => {
    const db = freshDb();
    const real = mk(db, "性能测试报告：并发抬到10耗时降四成");
    const distractor = mk(db, "个性化推荐的单元测试夹具改造"); // 后插，同分时按 id DESC 反超
    const got = ids(db, "性能测试");
    // 两者同为2分，排序退化到 occurred_at/id DESC → 噪音（后插）反超真命中，污染有限结果集
    expect(got[0]).toBe(real.id);
  });

  test("REGRESSION：'主要问题' 塌成单字 [主] → 命中一切含'主'的无关记忆", () => {
    const db = freshDb();
    // 要=停用字、问题=停用词，全剥后只剩 主 → required1 → 任何含 主 的记忆都被拉出
    const m1 = mk(db, "主机迁移到新机房");
    const m2 = mk(db, "业主群里吵起来了");
    const got = ids(db, "主要问题");
    expect(got).not.toContain(m1.id);
    expect(got).not.toContain(m2.id);
  });
});

// ───────────────────────── U38 listReceiptsChrono 软筛按 kind 正文字段 ─────────────────────────
describe("U38 软筛只匹配正文字段，键名/JSON骨架不假命中", () => {
  const SINCE = "2026-06-12T16:00:00.000Z";
  const UNTIL = "2026-06-13T16:00:00.000Z";
  const seed = (db: ReturnType<typeof freshDb>) => {
    appendSituation(db, { kind: "user_message", project: "/proj", payload: { text: "把护栏补上", uuid: "11111111-1111-1111-1111-111111111111" }, occurredAt: "2026-06-13T07:00:00.000Z" }, clock);
    appendSituation(db, { kind: "command_run", project: "/proj", payload: { command: "bun test", category: "test", ok: false, output: "boom" }, occurredAt: "2026-06-13T05:00:00.000Z" }, clock);
    appendSituation(db, { kind: "file_edit", project: "/proj", payload: { path: "/proj/a.ts", tool: "Edit", change: "改了点东西" }, occurredAt: "2026-06-13T06:00:00.000Z" }, clock);
    appendSituation(db, { kind: "file_read", project: "/proj", payload: { path: "/proj/设计稿.md" }, occurredAt: "2026-06-13T06:30:00.000Z" }, clock);
  };
  const q = (db: ReturnType<typeof freshDb>, query: string, kinds?: readonly string[]) =>
    listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj", query, kinds });

  test("键名/结构字全数不假命中（text/uuid/command/category/output/ok/path/tool/change）", () => {
    const db = freshDb();
    seed(db);
    for (const key of ["text", "uuid", "command", "category", "output", "ok", "path", "tool", "change"]) {
      expect(q(db, key)).toEqual([]); // 旧 bug：整串 payload LIKE → 这些键名会假命中
    }
  });

  test("正文字段各走各的字段照常命中", () => {
    const db = freshDb();
    seed(db);
    expect(q(db, "bun test").length).toBe(1); // command_run.command
    expect(q(db, "设计稿").length).toBe(1); // file_read.path
    expect(q(db, "护栏").length).toBe(1); // user_message.text
  });

  test("判别性：'path' 命中 command 正文含 path 的行，不命中 path 只作键名的 file_read", () => {
    const db = freshDb();
    appendSituation(db, { kind: "command_run", project: "/proj", payload: { command: "grep path src/", ok: true }, occurredAt: "2026-06-13T05:00:00.000Z" }, clock);
    appendSituation(db, { kind: "file_read", project: "/proj", payload: { path: "/proj/config.md" }, occurredAt: "2026-06-13T06:00:00.000Z" }, clock); // path 值不含子串 "path"
    const rows = q(db, "path");
    expect(rows.length).toBe(1);
    expect(rows[0]!.line).toContain("grep path src/");
  });

  test("不过度抑制：'command' 作为 user_message 正文出现时照常命中", () => {
    const db = freshDb();
    appendSituation(db, { kind: "user_message", project: "/proj", payload: { text: "把 command 那段注释解释一下" }, occurredAt: "2026-06-13T07:00:00.000Z" }, clock);
    expect(q(db, "command").length).toBe(1); // 键名会被挡，但真出现在正文里必须收
  });

  test("escapeLike 保持：'foo_bar' 下划线是字面（file_edit.path 路）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_edit", project: "/proj", payload: { path: "/src/foo_bar.ts" }, occurredAt: "2026-06-13T06:00:00.000Z" }, clock);
    appendSituation(db, { kind: "file_edit", project: "/proj", payload: { path: "/src/fooXbar.ts" }, occurredAt: "2026-06-13T06:30:00.000Z" }, clock);
    const rows = q(db, "foo_bar");
    expect(rows.length).toBe(1);
    expect(rows[0]!.line).toContain("foo_bar.ts");
  });

  test("file_edit 只匹配 path（change 值不入软筛，符合 U38 字段约定）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_edit", project: "/proj", payload: { path: "/proj/a.ts", change: "修复水位线回退" }, occurredAt: "2026-06-13T06:00:00.000Z" }, clock);
    expect(q(db, "水位线")).toEqual([]); // 词只在 change → 按约定不命中（file_edit→path）
  });

  test("非默认 kind 兜底整串 payload（宁可多收不静默漏收，设计口径）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "tool_error", project: "/proj", payload: { tool: "Bash", snippet: "命令炸了 permission denied" }, occurredAt: "2026-06-13T06:00:00.000Z" }, clock);
    // tool_error 不在 CASE → ELSE 整串 payload：正文值命中
    expect(q(db, "permission", ["tool_error"]).length).toBe(1);
  });
});

// ───────────────────────── 修订复验（2026-07-02，team-lead 二档虚词方案后）─────────────────────────
// 结论：三条回归已修（上方 describe("U27 零回归缺陷…") 现已全绿）。以下守核心域词零回归 + 钉已知残余。
describe("修订复验：核心中文域词零回归（tier2 会/能/要 在真实术语里整段保留＝旧 bigram）", () => {
  // 逐字核实：会/能/要 处在真实术语的安全位（词首/词尾/一侧仅单字）→ 不切、整段 bigram，与修前字节等价。
  test("会/能/要 域词整段保留（不再被打散成单字）", () => {
    expect(segmentQuery("性能测试")).toEqual(["性能", "能测", "测试"]);
    expect(segmentQuery("功能测试")).toEqual(["功能", "能测", "测试"]);
    expect(segmentQuery("性能瓶颈")).toEqual(["性能", "能瓶", "瓶颈"]);
    expect(segmentQuery("会话管理")).toEqual(["会话", "话管", "管理"]);
    expect(segmentQuery("会话恢复")).toEqual(["会话", "话恢", "恢复"]);
    expect(segmentQuery("智能助手")).toEqual(["智能", "能助", "助手"]);
    expect(segmentQuery("自愈能力")).toEqual(["自愈", "愈能", "能力"]);
    expect(segmentQuery("语义能力")).toEqual(["语义", "义能", "能力"]);
    expect(segmentQuery("可能性分析")).toEqual(["可能", "能性", "性分", "分析"]);
    expect(segmentQuery("需要重构")).toEqual(["需要", "要重", "重构"]);
    expect(segmentQuery("主要瓶颈")).toEqual(["主要", "要瓶", "瓶颈"]);
    expect(segmentQuery("被动模式")).toEqual(["被动", "动模", "模式"]);
    expect(segmentQuery("请求超时")).toEqual(["请求", "求超", "超时"]);
    expect(segmentQuery("主要问题")).toEqual(["主要"]); // 问题=停用词切走，主要保留（不再塌成[主]）
  });

  test("域词召回精确：'会话管理' 召回真命中、不误召无关记忆", () => {
    const db = freshDb();
    const real = mk(db, "会话管理模块重写：worker 私有队列");
    const noise = mk(db, "完全无关的日志轮转策略");
    const got = ids(db, "会话管理");
    expect(got).toContain(real.id);
    expect(got).not.toContain(noise.id);
  });

  test("'性能测试' 域词召回精确（回归修复的端到端确认）：真命中在、无关的个性化测试不召回也不反超", () => {
    const db = freshDb();
    const real = mk(db, "性能测试报告：并发抬到10耗时降四成");
    const distractor = mk(db, "个性化推荐的单元测试夹具改造");
    const got = ids(db, "性能测试");
    expect(got).toContain(real.id);
    expect(got).not.toContain(distractor.id);
    expect(got[0]).toBe(real.id);
  });
});

describe("修订复验：已知残余（非阻断·dict-free 启发式固有·钉住供知情决策）", () => {
  // 二档方案把 tier2（会/能/要…）收窄到"两侧≥2 才切"，消灭了核心域词的单字打散；但仍无法字典级消歧：
  //  · tier1 的/了/吧 词内成分（目的地/不了解/网吧X）仍打散成单字残段；
  //  · tier2 "两侧≥2"边界处的真词（太阳能电池/领导会见客户）仍被切。
  // 二者都非本项目核心域词（'目的''了解''性能''会话' 等 2 字形均已保留），召回从不丢、仅有界精度成本。
  // 下列断言=当前行为的【定性钉】：日后上真分词器把它们修好时，这些断言会主动失败、提醒同步更新。
  test("特征钉：tier1/边界残余仍打散（记录现状，非期望值）", () => {
    expect(segmentQuery("目的地")).toEqual(["目", "地"]); // 的 词内 → 单字残段
    expect(segmentQuery("不了解")).toEqual(["不", "解"]); // 了 词内
    expect(segmentQuery("太阳能电池")).toEqual(["太阳", "电池"]); // 能 两侧≥2 → 太阳能被切
    expect(segmentQuery("领导会见客户")).toEqual(["领导", "见客", "客户"]); // 会见 被切
  });

  test("残余只伤精度不伤召回：打散后真命中仍在结果集（无召回回归）", () => {
    const db = freshDb();
    const r1 = mk(db, "这次出行的目的地是北京机场");
    expect(ids(db, "目的地")).toContain(r1.id);
    const r2 = mk(db, "太阳能电池板转换效率实验");
    expect(ids(db, "太阳能电池")).toContain(r2.id);
  });
});
