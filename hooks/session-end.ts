// SessionEnd 钩子：兜底采集 + 刷徽章。纯本地 SQLite 操作，毫秒级。
// 纪律（事故 2026-06-12 后）：hook 里绝不调 LLM——收工自评移交夜间消化的 makeup 阶段补齐。
import { openAnima } from "../src/index";
import { captureTranscript } from "../src/capture";
import { recordHookFailure, recordHookSuccess } from "../src/hookHealth";
import { refreshBadge } from "../src/badge";

// 递归保护：anima 拉起的 headless claude 里绝不执行 hook 逻辑
if (process.env.ANIMA_HEADLESS === "1") process.exit(0);

try {
  const input = JSON.parse(await Bun.stdin.text()) as {
    transcript_path?: string;
  };
  const { db, config, degraded } = openAnima();
  // R10 降级态：openAnima 已亮"待升级"徽章。只读库写必败（被裸 catch 吞成静默，gap4），且 refreshBadge
  // 会用心情标签盖掉"待升级"警示牌（gap1 回归）——整段跳过，只留可见信号。
  if (degraded) process.exit(0);
  try {
    if (input.transcript_path) captureTranscript(db, input.transcript_path);
    refreshBadge(db, config.badgePath);
    recordHookSuccess(db, "SessionEnd");
  } catch (e) {
    recordHookFailure(db, "SessionEnd", {
      error: String(e).slice(0, 300),
      threshold: config.hookAlertThreshold,
    });
  }
} catch {
  // 连库都开不了：安静退出
}
process.exit(0);
