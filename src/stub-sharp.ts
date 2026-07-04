// bun preload：把 `sharp` 这个裸 import 桩成 null。
// 缘由：@huggingface/transformers 的 src/utils/image.js 静态 `import sharp from 'sharp'`
// 处理图片用，而 anima 只做文本 embedding、永不碰图片。sharp 又是 bun 全局缓存软链
// 布局下原生 libvips 相对路径会断的脆依赖。transformers 里 `else if (sharp)` 已能优雅
// 处理 sharp 为空（只是不提供图片加载路径，正合我们意）。挂进 bunfig.toml 的 preload，
// 覆盖 bun run / bun test / launchd 夜跑所有入口。
import { plugin } from "bun";

plugin({
  name: "stub-sharp",
  setup(build) {
    // 桩成「真值函数」：image.js 的 `else if (sharp)` 门控只要 sharp 为真就走 Node 分支
    // （加载时仅定义闭包、不调用 sharp），从而绕过「一个图片库都没有」的抛错。我们永不读
    // 图片，故这个函数永不被调用；万一被调用，明确抛错而非静默。
    const stub = () => {
      throw new Error("anima stub-sharp: 仅文本 embedding，不支持图片处理");
    };
    build.module("sharp", () => ({
      exports: { default: stub },
      loader: "object",
    }));
  },
});
