// work-memory 采集层（§3A/§5.6）：file_read / command_run / file_edit 增强 + scrub + 截断
import { describe, expect, test } from "bun:test";
import { classifyCommand, extractEvents, scrubSecrets } from "../src/capture";
import type { TranscriptEntry } from "../src/transcript";

function e(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    type: "user",
    uuid: "u",
    sessionId: "s",
    cwd: "/p",
    timestamp: "2026-06-21T10:00:00.000Z",
    isMeta: false,
    isSidechain: false,
    role: "user",
    content: "",
    ...partial,
  };
}
// deno-lint-ignore no-explicit-any
const asst = (blocks: any[], uuid = "a") =>
  e({ type: "assistant", uuid, role: "assistant", content: blocks });
// deno-lint-ignore no-explicit-any
const res = (blocks: any[], uuid = "u2") => e({ uuid, content: blocks });
// deno-lint-ignore no-explicit-any
const byKind = (evs: any[], kind: string) => evs.filter((x) => x.kind === kind);

describe("file_read（只存路径，不存内容）", () => {
  test("成功读 → file_read{path}，payload 只有 path", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x.ts" } }]),
      res([{ type: "tool_result", tool_use_id: "r1", content: "a".repeat(9000), is_error: false }]),
    ]);
    const reads = byKind(ev, "file_read");
    expect(reads.length).toBe(1);
    expect(reads[0].payload).toEqual({ path: "/x.ts" }); // 绝不含文件内容
  });

  test("读出错 → 不产 file_read，产 tool_error", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x.ts" } }]),
      res([{ type: "tool_result", tool_use_id: "r1", content: "ENOENT", is_error: true }]),
    ]);
    expect(byKind(ev, "file_read").length).toBe(0);
    expect(byKind(ev, "tool_error").length).toBe(1);
  });
});

describe("command_run（白名单 + 分类 + 成败 + 输出摘要）", () => {
  test("classifyCommand：白名单内归类、外面 null", () => {
    expect(classifyCommand("docker build .")).toBe("deploy"); // docker 优先归 deploy
    expect(classifyCommand("kubectl apply -f x")).toBe("deploy");
    expect(classifyCommand("npm install left-pad")).toBe("install");
    expect(classifyCommand("bun add zod")).toBe("install");
    expect(classifyCommand("git status")).toBe("git");
    expect(classifyCommand("make build")).toBe("build");
    expect(classifyCommand("curl https://x")).toBe("net");
    expect(classifyCommand("gh pr list")).toBe("net");
    expect(classifyCommand("ls -la")).toBeNull();
    expect(classifyCommand("cd /tmp && echo hi")).toBeNull();
    expect(classifyCommand("cat foo.txt")).toBeNull();
  });

  test("git 成功 → command_run{category:git, ok:true, command 原文}", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "g", name: "Bash", input: { command: "git commit -m wip" } }]),
      res([{ type: "tool_result", tool_use_id: "g", content: "[main abc1] wip", is_error: false }]),
    ]);
    const c = byKind(ev, "command_run");
    expect(c.length).toBe(1);
    expect(c[0].payload.category).toBe("git");
    expect(c[0].payload.ok).toBe(true);
    expect(c[0].payload.command).toBe("git commit -m wip");
  });

  test("非白名单 Bash 成功 → 啥都不采（保旧噪音过滤）", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "l", name: "Bash", input: { command: "ls -la" } }]),
      res([{ type: "tool_result", tool_use_id: "l", content: "a\nb", is_error: false }]),
    ]);
    expect(byKind(ev, "command_run").length).toBe(0);
    expect(byKind(ev, "tool_error").length).toBe(0);
  });

  test("白名单命令失败 → command_run ok:false（不是 tool_error）", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "g", name: "Bash", input: { command: "git push" } }]),
      res([{ type: "tool_result", tool_use_id: "g", content: "! rejected", is_error: true }]),
    ]);
    const c = byKind(ev, "command_run");
    expect(c.length).toBe(1);
    expect(c[0].payload.ok).toBe(false);
    expect(byKind(ev, "tool_error").length).toBe(0);
  });

  test("超长输出 → 截断（不存大 blob）", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "g", name: "Bash", input: { command: "git log" } }]),
      res([{ type: "tool_result", tool_use_id: "g", content: "Z".repeat(9000), is_error: false }]),
    ]);
    const out = byKind(ev, "command_run")[0].payload.output as string;
    expect(out.length).toBeLessThan(360); // 150+150+省略标记
    expect(out).toContain("省略");
  });
});

describe("file_edit 变更摘要（不存全文）", () => {
  test("Edit → change 含 old/new 关键片段", () => {
    // R3（AUDIT-2026-07-03）：file_edit 落库改到 tool_result 按 ok 门控——成功的编辑须配对 tool_result。
    const ev = extractEvents([
      asst([
        {
          type: "tool_use",
          id: "e1",
          name: "Edit",
          input: { file_path: "/a.ts", old_string: "TOML", new_string: "YAML" },
        },
      ]),
      res([{ type: "tool_result", tool_use_id: "e1", content: "The file /a.ts has been updated.", is_error: false }]),
    ]);
    const fe = byKind(ev, "file_edit")[0];
    expect(fe.payload.path).toBe("/a.ts");
    expect(fe.payload.change).toContain("TOML");
    expect(fe.payload.change).toContain("YAML");
  });

  test("超大 Edit → change 截断 < 260", () => {
    const big = "x".repeat(6000);
    const ev = extractEvents([
      asst([
        {
          type: "tool_use",
          id: "e1",
          name: "Edit",
          input: { file_path: "/a.ts", old_string: big, new_string: big },
        },
      ]),
      res([{ type: "tool_result", tool_use_id: "e1", content: "ok", is_error: false }]),
    ]);
    expect((byKind(ev, "file_edit")[0].payload.change as string).length).toBeLessThan(260);
  });
});

describe("scrub 隐私（§5.6，append-only 不可逆，宁可误打码）", () => {
  test("命令本身含密钥 → 整条不采（只留分类+成败）", () => {
    const ev = extractEvents([
      asst([
        {
          type: "tool_use",
          id: "c",
          name: "Bash",
          input: { command: "curl -H 'Authorization: Bearer sk-ABCdef1234567890XYZ' https://api.x" },
        },
      ]),
      res([{ type: "tool_result", tool_use_id: "c", content: "ok", is_error: false }]),
    ]);
    const c = byKind(ev, "command_run")[0];
    expect(c.payload.command).toBe("[命令含疑似密钥，未采]");
    expect(c.payload.category).toBe("net"); // 分类仍保留
    expect(JSON.stringify(c.payload)).not.toContain("sk-ABCdef1234567890XYZ");
  });

  test("危险类（net/deploy/install）输出整条不存、只留成败（轴⑤ hybrid）", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "g", name: "Bash", input: { command: "gh auth status" } }]),
      res([
        {
          type: "tool_result",
          tool_use_id: "g",
          content: "Logged in. Token: ghp_ABCdef1234567890abcdefGH",
          is_error: false,
        },
      ]),
    ]);
    const c = byKind(ev, "command_run")[0];
    const out = c.payload.output as string;
    // 危险类（gh=net）：输出正文不采 → 无名低熵密钥也无从泄漏；命令+成败+类别仍留
    expect(out).not.toContain("ghp_ABCdef1234567890abcdefGH");
    expect(out).not.toContain("Token");
    expect(out).toContain("未采");
    expect(c.payload.ok).toBe(true);
    expect(c.payload.category).toBe("net");
  });

  test("安全类（git/build）输出打码保留（不整条丢）", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "g", name: "Bash", input: { command: "git remote -v" } }]),
      res([
        {
          type: "tool_result",
          tool_use_id: "g",
          content: "origin\thttps://user:ghp_ABCdef1234567890abcdefGH@github.com/r.git (fetch)",
          is_error: false,
        },
      ]),
    ]);
    const out = byKind(ev, "command_run")[0].payload.output as string;
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghp_ABCdef1234567890abcdefGH");
  });

  test("git SHA（40 位小写 hex）不被误打码（codex n-3）", () => {
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    expect(scrubSecrets(`HEAD is now at ${sha} fix bug`)).toContain(sha);
    // 长路径（无数字）也不该被误杀
    expect(scrubSecrets("/Users/tester/Projects/anima/src/capture.ts")).toContain("capture.ts");
  });

  test("URL query 里的 token / basic-auth 密码不入库（盲考官 N-1）", () => {
    // 直接 scrubSecrets 单测
    expect(scrubSecrets("curl https://api.x/v1?token=AbC123dEf456GhX&q=1")).not.toContain("AbC123dEf456GhX");
    expect(scrubSecrets("curl 'https://h?api_key=Zk9Lm2Np4Qr'")).not.toContain("Zk9Lm2Np4Qr");
    expect(scrubSecrets("git clone https://user:p4ssw0rd123@github.com/r.git")).not.toContain("p4ssw0rd123");
    expect(scrubSecrets("curl https://admin:Secr3tPass@host/x")).not.toContain("Secr3tPass");
    // 端到端：含 URL token 的命令 → 整条不采（只留分类+成败）
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "c", name: "Bash", input: { command: "curl https://api.x?token=AbC123dEf456GhX" } }]),
      res([{ type: "tool_result", tool_use_id: "c", content: "ok", is_error: false }]),
    ]);
    const c = byKind(ev, "command_run")[0];
    expect(JSON.stringify(c.payload)).not.toContain("AbC123dEf456GhX");
    expect(c.payload.category).toBe("net");
  });

  test("OAuth/curl 常见密钥形态不入库（盲考官 N-1b）", () => {
    expect(scrubSecrets("curl 'https://h?client_secret=AbC123dEf'")).not.toContain("AbC123dEf");
    expect(scrubSecrets("curl 'https://h?refresh_token=Xy9Zk2Np'")).not.toContain("Xy9Zk2Np");
    expect(scrubSecrets("curl 'https://h?auth_token=Qr4St6Uv'")).not.toContain("Qr4St6Uv");
    expect(scrubSecrets("curl 'https://h?jsessionid=Sh0rtT0ken'")).not.toContain("Sh0rtT0ken");
    expect(scrubSecrets("curl -u admin:Sup3rSecret https://h")).not.toContain("Sup3rSecret");
    expect(scrubSecrets("curl -H 'X-Api-Key: mykey12345' https://h")).not.toContain("mykey12345");
    expect(scrubSecrets("curl --client-secret Zz9Yy8Xx https://h")).not.toContain("Zz9Yy8Xx");
    expect(scrubSecrets(`curl -d '{"token":"AbC123dEf456"}' https://h`)).not.toContain("AbC123dEf456");
  });

  test("普通 URL/命令（无敏感参数）不被误伤", () => {
    expect(scrubSecrets("curl https://example.com/api/v1/users?page=2&limit=10&sort=name")).toContain("page=2");
    expect(scrubSecrets("docker run -p 8080:80 img")).toContain("8080:80");
    expect(scrubSecrets("ssh git@github.com")).toContain("git@github.com"); // user@host 不误伤
    expect(scrubSecrets("curl http://localhost:3000/health")).toContain("localhost:3000"); // //host:port 不误伤
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    expect(scrubSecrets(`checkout ${sha}`)).toContain(sha); // git SHA 不误杀
  });

  test("scrub 在截断之前：跨 head 边界的密钥不漏片段", () => {
    const secret = "ghp_A1b2C3d4E5f6G7h8J9"; // ghp_ 前缀
    const long = "x".repeat(140) + secret + "y".repeat(500); // 密钥跨 150 head 切口
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "g", name: "Bash", input: { command: "gh api repos" } }]),
      res([{ type: "tool_result", tool_use_id: "g", content: long, is_error: false }]),
    ]);
    const out = byKind(ev, "command_run")[0].payload.output as string;
    // 若先截断后 scrub，head 会留 "ghp_A..." 残片且不匹配模式 → 泄漏；先 scrub 则不会
    expect(out).not.toContain("ghp_");
  });
});
