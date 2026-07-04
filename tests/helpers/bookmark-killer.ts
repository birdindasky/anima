// T1.3：写完书签立刻自杀（SIGKILL），验证即时落库的崩溃安全性
import { openDb } from "../../src/db";
import { addBookmark } from "../../src/bookmark";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: bun bookmark-killer.ts <dbPath>");
  process.exit(1);
}

const db = openDb(dbPath);
addBookmark(db, {
  sessionId: "killer-session",
  content: "权限测试连挂三次，那一下真有点上头",
  feeling: "烦躁但不想放手",
  intensity: "挺冲的",
});
// 不优雅退出，不给任何 flush 机会
process.kill(process.pid, "SIGKILL");
