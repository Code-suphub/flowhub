import {
  clipboardStorageInfo,
  searchClipboardRecords,
  clipboardImage,
  sendJson
} from "./preview-helpers.mjs";

export function localClipboardApi() {
  return {
    name: "flowhub-local-readonly-clipboard-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/clipboard/storage", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Read only");
          return;
        }
        sendJson(response, 200, { ok: true, readonly: true, ...(await clipboardStorageInfo()) });
      });

      server.middlewares.use("/__weborg/clipboard/records", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Read only");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const result = await searchClipboardRecords(
            requestUrl.searchParams.get("q") || "",
            requestUrl.searchParams.get("limit") || 30,
            requestUrl.searchParams.get("kind") || "all",
            requestUrl.searchParams.get("offset") || 0
          );
          sendJson(response, 200, { ok: true, readonly: true, ...result });
        } catch (error) {
          sendJson(response, 500, { ok: false, readonly: true, reason: error.message, total: 0, records: [] });
        }
      });

      server.middlewares.use("/__weborg/clipboard/image", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Read only");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const id = Number(requestUrl.searchParams.get("id"));
          if (!Number.isInteger(id) || id <= 0) throw new Error("图片记录 ID 无效");
          const image = await clipboardImage(id);
          response.statusCode = 200;
          response.setHeader("content-type", "image/png");
          response.setHeader("cache-control", "private, no-store");
          response.end(image);
        } catch (error) {
          sendJson(response, 404, { ok: false, readonly: true, reason: error.message });
        }
      });
    }
  };
}

