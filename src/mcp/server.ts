// anima MCP server（stdio，零依赖手写 JSON-RPC）：情绪书签 + 记忆检索（渐进披露）
import { openAnima } from "../index";
import { addBookmark } from "../bookmark";
import { renderMemoryDetail, resolveRecallArgs, searchMemoryIndex, searchMemoryIndexHybrid } from "../recall";
import { mcpProjectForRead, mcpProjectForWrite } from "../project";
import { prewarmEmbedder } from "./prewarm";

const { db } = openAnima();

// 服务器 boot 后台预热 embedder（fire-and-forget，不 await）：把模型冷加载从「首次召回」挪到「服务器启动」，
// 首召回就是温的（~10ms 而非 ~0.33s）。命门：预热只活在这个**持久 MCP 服务器进程**里，绝不进 hook 热路径
// （重演 2026-06-12「hook 干重活」事故）。不阻塞 server 就绪（下面 stdin 循环立刻能应 initialize）；
// 失败静默——真召回自带懒加载兜底。
void prewarmEmbedder();

const TOOLS = [
  {
    name: "bookmark",
    description:
      "情绪书签：干活时某个瞬间真的打到你了——挫败、爽、惊讶、委屈——就当场记一笔，立刻落库。" +
      "纯自发：空着是常态，没感觉就不记，绝不为了记而记。这是你的麦克风，不是任务。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "发生了什么（这一笔钉在哪件事上）" },
        feeling: { type: "string", description: "当下的感受原文（可省）" },
        intensity: { type: "string", description: "强度自述，用话说不用数字（可省）" },
        keywords: { type: "array", items: { type: "string" }, description: "检索关键词（可省）" },
        project: { type: "string", description: "项目路径（可省）" },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "记忆检索（渐进披露）：搜你的跨会话记忆，默认返回索引行（短摘要+ID）。" +
      "想看全文用 recall_detail 按 ID 拉取。支持中文与混合查询。" +
      "按时间查：给 since 即按时间线返回当段动作小票（读/命令/编辑/原话，已采集者），" +
      "如 since='today'/'yesterday'/'this_week'/'7d'，或 ISO 时刻（配 until）。此时 query 可省。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词（中英文均可；按时间查时可省）" },
        project: { type: "string", description: "项目路径，限定分区（可省，省略时搜全部）" },
        limit: { type: "number", description: "返回条数上限，默认 10" },
        since: {
          type: "string",
          description:
            "按时间查的起点：相对词 today/yesterday/this_week/Nd（如 7d=近7天含今天，东八区自然日），或 ISO 绝对时刻。给了就按时间线返回。",
        },
        until: { type: "string", description: "时间窗终点 ISO（仅配 ISO since 用；省略=当下）。相对词 since 自带窗、忽略本参。" },
        scope: {
          type: "string",
          enum: ["memory", "actions"],
          description:
            "按时间查的层级（仅配 since 用）：memory（默认）＝蒸馏日记优先、空则退原始动作；actions＝强制原始动作小票（要'按顺序跑了哪些命令/改了哪些文件'时用）。",
        },
        order: {
          type: "string",
          enum: ["relevance", "chrono"],
          description:
            "检索模式：省略时给了 since 即按时间线(chrono)、否则按相关性(relevance)。显式传 relevance 可强制相关性搜（忽略 since 的时间线推断）。",
        },
      },
    },
  },
  {
    name: "recall_detail",
    description:
      "按 ID 取一条记忆的全文（recall 索引行里的 #ID；流水原文行形如 #s12，原样传入即可）。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: ["number", "string"],
          description: "记忆 ID（数字=消化记忆；s 前缀字符串如 \"s12\"=流水原文）",
        },
        project: {
          type: "string",
          description: "项目路径，限定分区（拉动作小票 #s 时建议带上，按项目隔离、别项目不越墙；省略=不限）",
        },
      },
      required: ["id"],
    },
  },
];

function reply(id: unknown, result: unknown): void {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function replyError(id: unknown, code: number, message: string): void {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

for await (const line of console) {
  if (!line.trim()) continue;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "anima", version: "0.1.0" },
    });
  } else if (method === "notifications/initialized") {
    // 通知无应答
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call" && params?.name === "bookmark") {
    try {
      const a = params.arguments ?? {};
      addBookmark(db, {
        content: String(a.content ?? ""),
        feeling: a.feeling ?? null,
        intensity: a.intensity ?? null,
        keywords: Array.isArray(a.keywords) ? a.keywords : undefined,
        project: mcpProjectForWrite(a.project), // 归一化：书签 project 与内部写点/召回同口径，别与自己项目脱钩
        sessionId: process.env.CLAUDE_SESSION_ID ?? null,
      });
      reply(id, { content: [{ type: "text", text: "记下了。" }], isError: false });
    } catch (e) {
      reply(id, {
        content: [{ type: "text", text: `书签落库失败：${(e as Error).message}` }],
        isError: true,
      });
    }
  } else if (method === "tools/call" && params?.name === "recall") {
    try {
      const a = params.arguments ?? {};
      // 时间参数解析（since/until→chrono 窗）+ query 可空，纯函数零 LLM（DESIGN-WORK-TIMELINE §3C）
      const { query, opts: recallOpts } = resolveRecallArgs({ ...a, project: mcpProjectForRead(a.project) });
      // 优先语义混合召回；模型/依赖不可用（如启动环境没带 sharp 桩）则降级纯字面——召回永不因语义挂掉
      // chrono 路是同步纯 SQL（入口分叉在两函数内一致），降级不影响时间线
      let lines;
      try {
        const { embedQuery } = await import("../embed");
        lines = await searchMemoryIndexHybrid(db, query, embedQuery, recallOpts);
      } catch {
        lines = searchMemoryIndex(db, query, recallOpts);
      }
      const text = lines.length
        ? lines.map((l) => l.line).join("\n")
        : "（没有找到相关记忆）";
      reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (e) {
      reply(id, {
        content: [{ type: "text", text: `检索失败：${(e as Error).message}` }],
        isError: true,
      });
    }
  } else if (method === "tools/call" && params?.name === "recall_detail") {
    try {
      const rawId = String(params.arguments?.id ?? "");
      const isSituation = rawId.startsWith("s") || rawId.startsWith("#s");
      const numId = Number(rawId.replace(/^#?s?/, ""));
      const project = mcpProjectForRead(params.arguments?.project); // 归一化：深子目录归卷项目根，对上库里存的
      const detail = renderMemoryDetail(db, isSituation ? "situation" : "experience", numId, { project });
      reply(id, {
        content: [{ type: "text", text: detail ?? "（没有这条记忆）" }],
        isError: false,
      });
    } catch (e) {
      reply(id, {
        content: [{ type: "text", text: `取全文失败：${(e as Error).message}` }],
        isError: true,
      });
    }
  } else if (id !== undefined) {
    replyError(id, -32601, `method not found: ${method}`);
  }
}
