import { readFile } from "node:fs/promises";
import {
  activeConfigPath,
  configFileInfo,
  hydrateWebCatalog,
  sendJson
} from "./preview-helpers.mjs";

export function localConfigApi() {
  return {
    name: "weborg-local-config-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/config", async (request, response) => {
        // Reject before resolving user paths or consuming any request body.
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          sendJson(response, 405, { ok: false, readonly: true, reason: "浏览器预览不能修改配置" });
          return;
        }
        try {
          if ((request.url || "").startsWith("/location")) {
            sendJson(response, 200, { ok: true, readonly: true, ...(await configFileInfo()) });
            return;
          }
          const configPath = await activeConfigPath();
          const config = JSON.parse(await readFile(configPath, "utf8"));
          sendJson(response, 200, await hydrateWebCatalog(config));
        } catch (error) {
          sendJson(response, 400, { ok: false, reason: error.message });
        }
      });
    }
  };
}

