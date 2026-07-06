// SessionStart 钩子（正式版，注入开）：立即组装注入（stdout 即上下文）。永不阻塞开工。
// 纪律（事故 2026-06-12 后）：hook 绝不拉起后台消化——发现积压只如实报告，
// 消化由 launchd（02:00,补跑 04/06/08）或用户手动 bun scripts/digest.ts 跑。
import { openAnima } from "../src/index";
import { prepareSessionStart } from "../src/sessionStart";
import { recordHookFailure, recordHookSuccess } from "../src/hookHealth";
import { normalizeProject } from "../src/project";

// 递归保护：anima 拉起的 headless claude 里绝不执行 hook 逻辑
if (process.env.ANIMA_HEADLESS === "1") process.exit(0);

try {
  const input = JSON.parse(await Bun.stdin.text()) as { session_id?: string; cwd?: string };
  const { db, config, degraded } = openAnima();
  // R10 降级态（库比代码新、只读开库）：openAnima 已把"待升级"警示牌写进徽章。此时绝不能再走写路径——
  // ① 只读库上组装注入里的 recordInjection/记账都会失败被裸 catch 吞成静默；② 更别拿"比代码新"的降级库
  // 组装并注入可能已变义的上下文。对齐 stop/session-end：degraded 即 bail，只留可见信号（徽章）。
  if (degraded) process.exit(0);
  try {
    // 不传 spawnDigestion：只组装注入 + 报告积压，绝不在 hook 里启动后台任务
    const out = prepareSessionStart(db, {
      sessionId: input.session_id ?? "unknown-session",
      project: normalizeProject(input.cwd),
      personalityPath: config.personalityPath,
    });
    console.log(out.text);
    recordHookSuccess(db, "SessionStart");
  } catch (e) {
    recordHookFailure(db, "SessionStart", {
      error: String(e).slice(0, 300),
      threshold: config.hookAlertThreshold,
    });
  }
} catch {
  // 连库都开不了：安静退出，绝不挡开工
}
process.exit(0);
