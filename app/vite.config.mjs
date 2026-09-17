import { defineConfig } from "vite";
import { uiDirectory } from "./dev/preview-helpers.mjs";
import { localConfigApi } from "./dev/config-api.mjs";
import { localApplicationApi } from "./dev/application-api.mjs";
import { localClipboardApi } from "./dev/clipboard-api.mjs";
import { localNetworkApi } from "./dev/network-api.mjs";

// 只保留构建/开发服务器配置；四个本机 mock API 与图标抽取见 app/dev/。
export default defineConfig({
  root: uiDirectory,
  plugins: [localConfigApi(), localApplicationApi(), localClipboardApi(), localNetworkApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
