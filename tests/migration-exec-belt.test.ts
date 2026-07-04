// AUDIT-2026-07-01：迁移逐条 exec 护栏。bun:sqlite 的 db.exec(多语句串) 有静默吞错洞——某条语句运行期
// 失败时不抛、还继续跑后面的语句 → 半截迁移被 runMigrationTx 记成完成、schema_version 照推、坏状态零报错
// 永不重试。修：迁移 DDL 按语句拆开(splitSqlStatements，触发器体 BEGIN…END 内的 ; 保护不断句)逐条 exec，
// 单语句出错必抛 → 冒泡回事务回滚、版本不推、下轮重试。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { splitSqlStatements } from "../src/db";

describe("迁移逐条 exec 护栏（框架静默吞错）", () => {
  test("splitSqlStatements：触发器体内的 ; 不断句、整条保留", () => {
    const ddl = `CREATE TABLE t(x);
CREATE TRIGGER tr AFTER INSERT ON t BEGIN
  INSERT INTO u VALUES(1);
  INSERT INTO u VALUES(2);
END;
CREATE INDEX ix ON t(x);`;
    const s = splitSqlStatements(ddl);
    expect(s.length).toBe(3); // table / trigger(整条) / index —— 触发器没被内部 ; 拆碎
    expect(s[1]).toContain("CREATE TRIGGER");
    expect(s[1]).toContain("END");
    expect((s[1]!.match(/INSERT INTO u/g) ?? []).length).toBe(2); // 触发器体内两条 INSERT INTO u 都在（AFTER INSERT 不算）
    expect(s[2]).toContain("CREATE INDEX");
  });

  test("去整行注释；纯注释/空串不产生空语句", () => {
    expect(splitSqlStatements("-- 只是注释\n")).toEqual([]);
    expect(splitSqlStatements("CREATE TABLE t(x); -- 行尾注释\n")).toEqual(["CREATE TABLE t(x)"]);
    expect(splitSqlStatements("")).toEqual([]);
  });

  test("反证 + 护栏：db.exec 整串中间失败被吞且续跑；逐条 exec 则抛错并停在失败处", () => {
    // 反证：整串 db.exec —— 中间 CREATE UNIQUE 失败被静默吞，后一条 CREATE t2 照建，exec 不抛
    const bad = new Database(":memory:");
    bad.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1); INSERT INTO t VALUES(1);");
    let swallowed = true;
    try {
      bad.exec("CREATE UNIQUE INDEX ix ON t(x);\nCREATE TABLE t2(y);\n");
    } catch {
      swallowed = false;
    }
    expect(swallowed).toBe(true); // 坐实：不抛
    expect(!!bad.query("SELECT 1 FROM sqlite_master WHERE name='ix'").get()).toBe(false); // 索引没建成
    expect(!!bad.query("SELECT 1 FROM sqlite_master WHERE name='t2'").get()).toBe(true); // 却继续建了 t2
    bad.close();

    // 护栏：逐条 exec —— 失败那条抛错、停下、后一条不执行
    const good = new Database(":memory:");
    good.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1); INSERT INTO t VALUES(1);");
    let threw = false;
    try {
      for (const s of splitSqlStatements("CREATE UNIQUE INDEX ix ON t(x);\nCREATE TABLE t2(y);\n")) good.exec(s);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // 出错必抛
    expect(!!good.query("SELECT 1 FROM sqlite_master WHERE name='t2'").get()).toBe(false); // 停在失败处、t2 没建
    good.close();
  });
});
