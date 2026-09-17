import {
  applications,
  searchApplications,
  loadApplicationIcons,
  sendJson
} from "./preview-helpers.mjs";

export function localApplicationApi() {
  return {
    name: "weborg-local-application-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/apps", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const applications = await searchApplications(requestUrl.searchParams.get("q") || "", requestUrl.searchParams.get("limit") || 12, requestUrl.searchParams.get("offset") || 0, requestUrl.searchParams.get("icons") !== "0");
          sendJson(response, 200, { ok: true, applications });
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: error.message, applications: [] });
        }
      });
      server.middlewares.use("/__weborg/app-icons", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const raw = requestUrl.searchParams.get("paths") || "[]";
          const paths = JSON.parse(raw);
          const icons = await loadApplicationIcons(Array.isArray(paths) ? paths : []);
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ ok: true, icons }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ ok: false, reason: error.message }));
        }
      });
    }
  };
}

