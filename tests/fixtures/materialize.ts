// Fixture 物化：把 fixture 里的占位 home（/Users/tester）替换成本机真实 homedir，落到临时文件。
// 为什么必须这样：normalizeProject（src/project.ts）用真 homedir() 判「~/Projects/<name>」项目根，
// 静态假路径在任何机器上都不在真 home 下 → 一律归一成 null，project 断言就失真。
// 物化后 fixture 在任何机器上语义一致：cwd 恒为「本机 home 下的 Projects/demo」。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PLACEHOLDER_HOME = "/Users/tester";

/** fixture 里 cwd 归一后的期望项目标签（断言用这个，别写死路径）。 */
export const DEMO_PROJECT = join(homedir(), "Projects", "demo");

/** 把 fixture 复制为占位 home 已替换的临时文件，返回新路径。临时目录由 OS 清理。 */
export function materializeFixture(path: string): string {
  const raw = readFileSync(path, "utf8").replaceAll(PLACEHOLDER_HOME, homedir());
  const out = join(mkdtempSync(join(tmpdir(), "anima-fixture-")), "transcript.jsonl");
  writeFileSync(out, raw);
  return out;
}
