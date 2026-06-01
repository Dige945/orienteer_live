export { EventRoom } from "./event-room.js";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-admin-password",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS"
  }
});

function adminPassword(env) {
  return env.ADMIN_PASSWORD || "admin123";
}

function isAdmin(request, env) {
  return request.headers.get("x-admin-password") === adminPassword(env);
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

function routeMatch(pathname, pattern) {
  const parts = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (parts.length !== expected.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(":")) {
      params[expected[i].slice(1)] = decodeURIComponent(parts[i]);
    } else if (expected[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

function currentRoom(env) {
  const id = env.EVENT_ROOM.idFromName("single-event");
  return env.EVENT_ROOM.get(id);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });

    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, runtime: "cloudflare-worker", time: new Date().toISOString() });
    }

    if (pathname === "/api/diagnostics" && request.method === "GET") {
      const room = currentRoom(env);
      const response = await room.fetch(new Request("https://room/diagnostics"));
      const data = await response.json();
      return json({
        ok: true,
        runtime: "cloudflare-worker",
        time: new Date().toISOString(),
        ...data
      });
    }

    if (pathname === "/api/admin/login" && request.method === "POST") {
      const body = await readJson(request);
      if (body.password !== adminPassword(env)) return json({ error: "Admin password required" }, 401);
      return json({ ok: true });
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
      const room = currentRoom(env);
      const forwarded = new Request(request);
      forwarded.headers.set("x-admin-ok", isAdmin(request, env) ? "1" : "0");
      return room.fetch(forwarded);
    }

    return json({ error: "Not found" }, 404);
  }
};
