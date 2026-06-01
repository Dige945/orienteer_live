const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "maps");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const OFFLINE_AFTER_MS = 90 * 1000;
const MAX_REASONABLE_SPEED_MPS = 12;
const MAX_REASONABLE_JUMP_METERS = 80;
const MIN_JUMP_SECONDS = 1;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const defaultStore = {
  events: [],
  mapImages: {},
  runners: {},
  locationPoints: [],
  liveStates: {}
};

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return structuredClone(defaultStore);
  return { ...structuredClone(defaultStore), ...JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) };
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

let store = readStore();
const wsRooms = new Map();

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function eventCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function unauthorized(res) {
  sendJson(res, 401, { error: "Admin password required" });
}

function isAdminRequest(req) {
  return req.headers["x-admin-password"] === ADMIN_PASSWORD;
}

function requireAdmin(req, res) {
  if (isAdminRequest(req)) return true;
  unauthorized(res);
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return notFound(res);

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  };
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
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

function ensureEvent(eventId) {
  return store.events.find(event => event.id === eventId);
}

function findEventByIdOrCode(value) {
  return store.events.find(event => event.id === value || event.code === String(value || "").toUpperCase());
}

function normalizeEvent(event) {
  if (event.code) return event;
  event.code = eventCode();
  event.updatedAt = nowIso();
  writeStore(store);
  return event;
}

function transformFor(eventId) {
  return store.mapImages[eventId] || null;
}

function updateStore(mutator) {
  const result = mutator(store);
  writeStore(store);
  return result;
}

function normalizeLocation(point) {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("lat and lng are required numbers");
  }
  const coordSystem = point.coordSystem || "WGS84";
  return {
    id: id("loc"),
    eventId: point.eventId,
    runnerId: point.runnerId,
    lat,
    lng,
    displayLat: lat,
    displayLng: lng,
    coordSystem,
    accuracy: Number(point.accuracy || 0),
    speed: Number(point.speed || 0),
    heading: Number(point.heading || 0),
    timestamp: Number(point.timestamp || Date.now()),
    createdAt: nowIso()
  };
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const radius = 6371000;
  const toRad = degrees => degrees * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function classifyPoint(point, previousLive) {
  if (!previousLive?.lastAcceptedAt) return { accepted: true };
  const distance = distanceMeters(previousLive.latestLat, previousLive.latestLng, point.displayLat, point.displayLng);
  const seconds = Math.max(MIN_JUMP_SECONDS, (Date.now() - Number(previousLive.lastAcceptedAt || 0)) / 1000);
  const impliedSpeed = distance / seconds;
  const accuracy = Number(point.accuracy || 0);
  const badAccuracy = accuracy >= 50;
  const tooFast = distance >= MAX_REASONABLE_JUMP_METERS && impliedSpeed > MAX_REASONABLE_SPEED_MPS;
  if (tooFast || (badAccuracy && distance >= MAX_REASONABLE_JUMP_METERS)) {
    return {
      accepted: false,
      reason: tooFast ? "jump-speed" : "low-accuracy-jump",
      distance,
      impliedSpeed
    };
  }
  return { accepted: true, distance, impliedSpeed };
}

function liveStateFromPoint(point, receivedAt) {
  return {
    runnerId: point.runnerId,
    eventId: point.eventId,
    latestLat: point.displayLat,
    latestLng: point.displayLng,
    rawLat: point.lat,
    rawLng: point.lng,
    accuracy: point.accuracy,
    speed: point.speed,
    heading: point.heading,
    lastSeenAt: receivedAt,
    lastAcceptedAt: receivedAt,
    isOnline: true,
    rejectedCount: 0,
    lastRejectedReason: ""
  };
}

function appendLocationPoint(s, point) {
  const receivedAt = Date.now();
  const previousLive = s.liveStates[point.runnerId];
  const decision = classifyPoint(point, previousLive);
  point.receivedAt = receivedAt;
  point.rejected = !decision.accepted;
  point.rejectReason = decision.reason || "";
  point.jumpDistance = decision.distance ? Number(decision.distance.toFixed(1)) : 0;
  point.impliedSpeed = decision.impliedSpeed ? Number(decision.impliedSpeed.toFixed(2)) : 0;
  s.locationPoints.push(point);
  if (decision.accepted || !previousLive) {
    s.liveStates[point.runnerId] = liveStateFromPoint(point, receivedAt);
  } else {
    s.liveStates[point.runnerId] = {
      ...previousLive,
      lastSeenAt: receivedAt,
      isOnline: true,
      rejectedCount: Number(previousLive.rejectedCount || 0) + 1,
      lastRejectedReason: point.rejectReason
    };
  }
}

function publicRunner(runner) {
  return {
    id: runner.id,
    eventId: runner.eventId,
    name: runner.name,
    deviceId: runner.deviceId || "",
    status: runner.status || "active",
    createdAt: runner.createdAt,
    updatedAt: runner.updatedAt
  };
}

function runnersForResponse(runners, includeUploadToken) {
  return includeUploadToken ? runners : runners.map(publicRunner);
}

function encodeWsFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function broadcast(eventId, payload) {
  const clients = wsRooms.get(eventId);
  if (!clients) return;
  const frame = encodeWsFrame(payload);
  for (const socket of clients) {
    if (!socket.destroyed) socket.write(frame);
  }
}

function liveSnapshot(eventId) {
  const now = Date.now();
  return Object.values(store.liveStates)
    .filter(state => state.eventId === eventId)
    .map(state => ({
      ...state,
      isOnline: now - Number(state.lastSeenAt || 0) <= OFFLINE_AFTER_MS,
      staleSeconds: Math.max(0, Math.round((now - Number(state.lastSeenAt || 0)) / 1000))
    }));
}

function ensureRunnerToken(runner) {
  if (!runner.uploadToken) runner.uploadToken = id("token");
  return runner.uploadToken;
}

function isValidUploadToken(eventId, runnerId, uploadToken) {
  const runner = (store.runners[eventId] || []).find(item => item.id === runnerId);
  if (!runner) return false;
  const token = ensureRunnerToken(runner);
  if (!uploadToken) return false;
  return token === uploadToken;
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, time: nowIso() });
    }

    if (req.method === "GET" && pathname === "/api/diagnostics") {
      const runnerCount = Object.values(store.runners).reduce((sum, runners) => sum + runners.length, 0);
      return sendJson(res, 200, {
        ok: true,
        time: nowIso(),
        events: store.events.length,
        runners: runnerCount,
        locationPoints: store.locationPoints.length,
        uploadsDir: UPLOAD_DIR,
        uploadsWritable: canWrite(UPLOAD_DIR),
        websocketPath: "/ws/events/:eventId/live"
      });
    }

    if (req.method === "POST" && pathname === "/api/admin/login") {
      const body = await readJson(req);
      if (body.password !== ADMIN_PASSWORD) return unauthorized(res);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/events") {
      let changed = false;
      for (const event of store.events) {
        if (!event.code) {
          event.code = eventCode();
          event.updatedAt = nowIso();
          changed = true;
        }
      }
      if (changed) writeStore(store);
      return sendJson(res, 200, { events: store.events });
    }

    if (req.method === "POST" && pathname === "/api/events") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const oldEventIds = store.events.map(event => event.id);
      const event = {
        id: id("event"),
        code: eventCode(),
        name: body.name || "未命名赛事",
        description: body.description || "",
        startTime: body.startTime || "",
        endTime: body.endTime || "",
        status: body.status || "draft",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      updateStore(s => {
        s.events = [event];
        s.mapImages = {};
        s.locationPoints = [];
        s.liveStates = {};
        s.runners = {};
        s.runners[event.id] = [];
      });
      for (const eventId of oldEventIds) {
        broadcast(eventId, { type: "event-deleted", eventId });
      }
      return sendJson(res, 201, { event });
    }

    let params = routeMatch(pathname, "/api/events/:eventId");
    if (params && req.method === "GET") {
      const event = ensureEvent(params.eventId);
      if (!event) return notFound(res);
      return sendJson(res, 200, { event: normalizeEvent(event) });
    }

    if (params && req.method === "PUT") {
      if (!requireAdmin(req, res)) return;
      const event = ensureEvent(params.eventId);
      if (!event) return notFound(res);
      const body = await readJson(req);
      event.name = body.name || event.name;
      event.description = body.description ?? event.description ?? "";
      event.status = body.status || event.status || "draft";
      event.startTime = body.startTime ?? event.startTime ?? "";
      event.endTime = body.endTime ?? event.endTime ?? "";
      event.updatedAt = nowIso();
      writeStore(store);
      broadcast(event.id, { type: "event-updated", event });
      return sendJson(res, 200, { event });
    }

    if (params && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;
      const event = ensureEvent(params.eventId);
      if (!event) return notFound(res);
      updateStore(s => {
        s.events = s.events.filter(item => item.id !== params.eventId);
        delete s.mapImages[params.eventId];
        delete s.runners[params.eventId];
        s.locationPoints = s.locationPoints.filter(point => point.eventId !== params.eventId);
        for (const [runnerId, live] of Object.entries(s.liveStates)) {
          if (live.eventId === params.eventId) delete s.liveStates[runnerId];
        }
      });
      broadcast(params.eventId, { type: "event-deleted", eventId: params.eventId });
      return sendJson(res, 200, { ok: true });
    }

    params = routeMatch(pathname, "/api/mobile/events/:eventIdOrCode");
    if (params && req.method === "GET") {
      const event = findEventByIdOrCode(params.eventIdOrCode);
      if (!event) return notFound(res);
      return sendJson(res, 200, { event: normalizeEvent(event) });
    }

    params = routeMatch(pathname, "/api/events/:eventId/map-image");
    if (params && req.method === "GET") {
      if (!ensureEvent(params.eventId)) return notFound(res);
      return sendJson(res, 200, { mapImage: transformFor(params.eventId) });
    }

    if (params && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      if (!ensureEvent(params.eventId)) return notFound(res);
      const body = await readJson(req);
      if (!body.dataBase64 || !body.mimeType) return badRequest(res, "dataBase64 and mimeType are required");
      const ext = body.mimeType.includes("png") ? "png" : body.mimeType.includes("webp") ? "webp" : "jpg";
      const filename = `${params.eventId}-${Date.now()}.${ext}`;
      const filePath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(filePath, Buffer.from(body.dataBase64, "base64"));
      const mapImage = {
        id: id("map"),
        eventId: params.eventId,
        imageUrl: `/uploads/maps/${filename}`,
        imageWidth: Number(body.imageWidth || 0),
        imageHeight: Number(body.imageHeight || 0),
        anchorLng: Number(body.anchorLng || 120.123456),
        anchorLat: Number(body.anchorLat || 30.123456),
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        rotation: 0,
        opacity: 0.65,
        zoom: Number(body.zoom || 16),
        provider: body.provider || "osm",
        calibration: body.calibration || null,
        overlayWidth: Number(body.overlayWidth || 900),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      updateStore(s => {
        s.mapImages[params.eventId] = mapImage;
      });
      return sendJson(res, 201, { mapImage });
    }

    params = routeMatch(pathname, "/api/events/:eventId/map-transform");
    if (params && req.method === "PUT") {
      if (!requireAdmin(req, res)) return;
      if (!ensureEvent(params.eventId)) return notFound(res);
      const existing = store.mapImages[params.eventId];
      if (!existing) return badRequest(res, "Upload a map image before saving transform");
      const body = await readJson(req);
      const mapImage = {
        ...existing,
        anchorLng: Number(body.anchorLng ?? existing.anchorLng),
        anchorLat: Number(body.anchorLat ?? existing.anchorLat),
        offsetX: Number(body.offsetX ?? existing.offsetX),
        offsetY: Number(body.offsetY ?? existing.offsetY),
        scale: Number(body.scale ?? existing.scale),
        rotation: Number(body.rotation ?? existing.rotation),
        opacity: Number(body.opacity ?? existing.opacity),
        zoom: Number(body.zoom ?? existing.zoom ?? 16),
        provider: body.provider || existing.provider || "osm",
        calibration: body.calibration || existing.calibration || null,
        overlayWidth: Number(body.overlayWidth ?? existing.overlayWidth ?? 900),
        updatedAt: nowIso()
      };
      updateStore(s => {
        s.mapImages[params.eventId] = mapImage;
      });
      broadcast(params.eventId, { type: "map-transform", mapImage });
      return sendJson(res, 200, { mapImage });
    }

    params = routeMatch(pathname, "/api/events/:eventId/runners");
    if (params && req.method === "GET") {
      if (!ensureEvent(params.eventId)) return notFound(res);
      const runners = store.runners[params.eventId] || [];
      let changed = false;
      for (const runner of runners) {
        if (!runner.uploadToken) {
          ensureRunnerToken(runner);
          changed = true;
        }
      }
      if (changed) writeStore(store);
      return sendJson(res, 200, { runners: runnersForResponse(runners, isAdminRequest(req)) });
    }

    if (params && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      if (!ensureEvent(params.eventId)) return notFound(res);
      const body = await readJson(req);
      const runner = {
        id: id("runner"),
        eventId: params.eventId,
        name: body.name || "未命名",
        deviceId: body.deviceId || "",
        uploadToken: id("token"),
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      updateStore(s => {
        s.runners[params.eventId] = s.runners[params.eventId] || [];
        s.runners[params.eventId].push(runner);
      });
      broadcast(params.eventId, { type: "runner-created", runner });
      return sendJson(res, 201, { runner });
    }

    params = routeMatch(pathname, "/api/events/:eventId/runners/:runnerId");
    if (params && req.method === "PUT") {
      if (!requireAdmin(req, res)) return;
      if (!ensureEvent(params.eventId)) return notFound(res);
      const runners = store.runners[params.eventId] || [];
      const runner = runners.find(item => item.id === params.runnerId);
      if (!runner) return notFound(res);
      const body = await readJson(req);
      runner.name = body.name || runner.name;
      runner.status = body.status || runner.status || "active";
      runner.updatedAt = nowIso();
      writeStore(store);
      broadcast(params.eventId, { type: "runner-updated", runner });
      return sendJson(res, 200, { runner });
    }

    if (params && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;
      if (!ensureEvent(params.eventId)) return notFound(res);
      const runners = store.runners[params.eventId] || [];
      const runner = runners.find(item => item.id === params.runnerId);
      if (!runner) return notFound(res);
      updateStore(s => {
        s.runners[params.eventId] = (s.runners[params.eventId] || []).filter(item => item.id !== params.runnerId);
        s.locationPoints = s.locationPoints.filter(point => point.runnerId !== params.runnerId);
        delete s.liveStates[params.runnerId];
      });
      broadcast(params.eventId, { type: "runner-deleted", runnerId: params.runnerId });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/mobile/join") {
      const body = await readJson(req);
      const event = findEventByIdOrCode(body.eventId || body.eventCode);
      if (!event) return notFound(res);
      normalizeEvent(event);
      const deviceId = body.deviceId || "";
      const runners = store.runners[event.id] || [];
      let runner = deviceId ? runners.find(item => item.deviceId === deviceId) : null;
      if (!runner) {
        runner = {
          id: id("runner"),
          eventId: event.id,
          name: body.name || "未命名",
          deviceId,
          uploadToken: id("token"),
          status: "active",
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        updateStore(s => {
          s.runners[event.id] = s.runners[event.id] || [];
          s.runners[event.id].push(runner);
        });
        broadcast(event.id, { type: "runner-created", runner: publicRunner(runner) });
      } else {
        ensureRunnerToken(runner);
        runner.name = body.name || runner.name || "未命名";
        runner.updatedAt = nowIso();
        writeStore(store);
        broadcast(event.id, { type: "runner-updated", runner: publicRunner(runner) });
      }
      return sendJson(res, 200, { event, runner });
    }

    if (req.method === "POST" && pathname === "/api/location/report") {
      const body = await readJson(req);
      if (!ensureEvent(body.eventId)) return notFound(res);
      if (!body.runnerId) return badRequest(res, "runnerId is required");
      if (!isValidUploadToken(body.eventId, body.runnerId, body.uploadToken)) return sendJson(res, 403, { error: "Invalid upload token" });
      const point = normalizeLocation(body);
      updateStore(s => {
        appendLocationPoint(s, point);
      });
      broadcast(point.eventId, { type: "location", point, liveStates: liveSnapshot(point.eventId) });
      return sendJson(res, 201, { point });
    }

    if (req.method === "POST" && pathname === "/api/location/batch-report") {
      const body = await readJson(req);
      const rawPoints = Array.isArray(body.points) ? body.points : [];
      if (rawPoints.some(point => !ensureEvent(point.eventId))) return notFound(res);
      if (rawPoints.some(point => !isValidUploadToken(point.eventId, point.runnerId, point.uploadToken || body.uploadToken))) {
        return sendJson(res, 403, { error: "Invalid upload token" });
      }
      const points = rawPoints.map(normalizeLocation);
      updateStore(s => {
        for (const point of points) {
          appendLocationPoint(s, point);
          broadcast(point.eventId, { type: "location", point, liveStates: liveSnapshot(point.eventId) });
        }
      });
      return sendJson(res, 201, { points });
    }

    params = routeMatch(pathname, "/api/events/:eventId/runners/:runnerId/track");
    if (params && req.method === "GET") {
      if (!ensureEvent(params.eventId)) return notFound(res);
      const track = store.locationPoints.filter(point => point.eventId === params.eventId && point.runnerId === params.runnerId);
      return sendJson(res, 200, { track });
    }

    params = routeMatch(pathname, "/api/events/:eventId/live");
    if (params && req.method === "GET") {
      if (!ensureEvent(params.eventId)) return notFound(res);
      return sendJson(res, 200, { liveStates: liveSnapshot(params.eventId) });
    }

    return notFound(res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname);
  } else {
    serveStatic(req, res, pathname);
  }
});

server.on("upgrade", (req, socket) => {
  const { pathname } = url.parse(req.url);
  const params = routeMatch(pathname, "/ws/events/:eventId/live");
  if (!params || !ensureEvent(params.eventId)) {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const room = wsRooms.get(params.eventId) || new Set();
  room.add(socket);
  wsRooms.set(params.eventId, room);
  socket.write(encodeWsFrame({ type: "snapshot", liveStates: liveSnapshot(params.eventId), mapImage: transformFor(params.eventId) }));
  socket.on("close", () => room.delete(socket));
  socket.on("error", () => room.delete(socket));
});

server.listen(PORT, () => {
  console.log(`Orienteer Live MVP running at http://localhost:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`LAN access: http://${address}:${PORT}`);
  }
});

function localAddresses() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === "IPv4" && !net.internal) results.push(net.address);
    }
  }
  return results;
}

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
