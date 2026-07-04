// /mood 面板入口：只读，估计现算，零 LLM 调用
import { openAnima } from "../src/index";
import { estimateMood, renderMoodPanel } from "../src/mood";

const { db, config } = openAnima();
console.log(renderMoodPanel(estimateMood(db), { badgePath: config.badgePath }));
