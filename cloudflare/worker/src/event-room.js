const defaultState = {
  events: [],
  mapImages: {},
  runners: {},
  locationPoints: [],
  liveStates: {}
};

const MAX_REASONABLE_SPEED_MPS = 12;
const MAX_REASONABLE_JUMP_METERS = 80;
const MIN_JUMP_SECONDS = 1;

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function eventCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
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

function extensionForMime(mimeType) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
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

export class EventRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.store = null;
  }

  async load() {
    if (this.store) return this.store;
    const stored = await this.state.storage.get("store");
    this.store = { ...clone(defaultState), ...(stored || {}) };
    return this.store;
  }

  async save() {
    await this.state.storage.put("store", this.store);
  }

  ensureEvent(eventId) {
    return this.store.events.find(event => event.id === eventId);
  }

  findEventByIdOrCode(value) {
    return this.store.events.find(event => event.id === value || event.code === String(value || "").toUpperCase());
  }

  liveSnapshot(eventId) {
    const now = Date.now();
    return Object.values(this.store.liveStates)
      .filter(state => state.eventId === eventId)
      .map(state => ({
        ...state,
        isOnline: now - Number(state.lastSeenAt || 0) <= 90 * 1000,
        staleSeconds: Math.max(0, Math.round((now - Number(state.lastSeenAt || 0)) / 1000))
      }));
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const socket of this.clients) {
      try {
        socket.send(text);
      } catch {
        this.clients.delete(socket);
      }
    }
  }

  requireAdmin(request) {
    return request.headers.get("x-admin-ok") === "1";
  }

  normalizeAndValidatePoint(rawPoint) {
    const runners = this.store.runners[rawPoint.eventId] || [];
    const runner = runners.find(item => item.id === rawPoint.runnerId && item.uploadToken === rawPoint.uploadToken);
    if (!runner) return null;
    const lat = Number(rawPoint.lat);
    const lng = Number(rawPoint.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      id: id("loc"),
      eventId: rawPoint.eventId,
      runnerId: rawPoint.runnerId,
      lat,
      lng,
      displayLat: lat,
      displayLng: lng,
      coordSystem: rawPoint.coordSystem || "WGS84",
      accuracy: Number(rawPoint.accuracy || 0),
      speed: Number(rawPoint.speed || 0),
      heading: Number(rawPoint.heading || 0),
      timestamp: Number(rawPoint.timestamp || Date.now()),
      createdAt: nowIso()
    };
  }

  appendPoint(point) {
    const receivedAt = Date.now();
    const previousLive = this.store.liveStates[point.runnerId];
    const decision = this.classifyPoint(point, previousLive);
    point.receivedAt = receivedAt;
    point.rejected = !decision.accepted;
    point.rejectReason = decision.reason || "";
    point.jumpDistance = decision.distance ? Number(decision.distance.toFixed(1)) : 0;
    point.impliedSpeed = decision.impliedSpeed ? Number(decision.impliedSpeed.toFixed(2)) : 0;
    this.store.locationPoints.push(point);
    this.store.locationPoints = this.store.locationPoints.slice(-5000);
    if (decision.accepted || !previousLive) {
      this.store.liveStates[point.runnerId] = {
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
      return;
    }
    this.store.liveStates[point.runnerId] = {
      ...previousLive,
      lastSeenAt: receivedAt,
      isOnline: true,
      rejectedCount: Number(previousLive.rejectedCount || 0) + 1,
      lastRejectedReason: point.rejectReason
    };
  }

  classifyPoint(point, previousLive) {
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

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/maps/") && request.method === "GET") {
      const key = decodeURIComponent(pathname.slice("/api/maps/".length));
      if (!this.env.MAPS) return json({ error: "R2 bucket is not configured" }, 404);
      const object = await this.env.MAPS.get(key);
      if (!object) return json({ error: "Not found" }, 404);
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable"
        }
      });
    }

    if (pathname === "/diagnostics") {
      const runnerCount = Object.values(this.store.runners).reduce((sum, runners) => sum + runners.length, 0);
      return json({
        events: this.store.events.length,
        runners: runnerCount,
        locationPoints: this.store.locationPoints.length,
        websocketPath: "/ws/events/:eventId/live"
      });
    }

    if (pathname === "/api/events" && request.method === "GET") {
      return json({ events: this.store.events });
    }

    if (pathname === "/api/events" && request.method === "POST") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      const body = await readJson(request);
      const event = {
        id: id("event"),
        code: eventCode(),
        name: body.name || "未命名赛事",
        description: body.description || "",
        status: body.status || "draft",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      this.store.events = [event];
      this.store.mapImages = {};
      this.store.runners = { [event.id]: [] };
      this.store.locationPoints = [];
      this.store.liveStates = {};
      await this.save();
      this.broadcast({ type: "event-deleted" });
      return json({ event }, 201);
    }

    let params = routeMatch(pathname, "/api/events/:eventId");
    if (params && request.method === "GET") {
      const event = this.ensureEvent(params.eventId);
      if (!event) return json({ error: "Not found" }, 404);
      return json({ event });
    }

    if (params && request.method === "PUT") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      const event = this.ensureEvent(params.eventId);
      if (!event) return json({ error: "Not found" }, 404);
      const body = await readJson(request);
      event.name = body.name || event.name;
      event.description = body.description ?? event.description ?? "";
      event.status = body.status || event.status || "draft";
      event.startTime = body.startTime ?? event.startTime ?? "";
      event.endTime = body.endTime ?? event.endTime ?? "";
      event.updatedAt = nowIso();
      await this.save();
      this.broadcast({ type: "event-updated", event });
      return json({ event });
    }

    if (params && request.method === "DELETE") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      const event = this.ensureEvent(params.eventId);
      if (!event) return json({ error: "Not found" }, 404);
      this.store.events = this.store.events.filter(item => item.id !== params.eventId);
      delete this.store.mapImages[params.eventId];
      delete this.store.runners[params.eventId];
      this.store.locationPoints = this.store.locationPoints.filter(point => point.eventId !== params.eventId);
      for (const [runnerId, live] of Object.entries(this.store.liveStates)) {
        if (live.eventId === params.eventId) delete this.store.liveStates[runnerId];
      }
      await this.save();
      this.broadcast({ type: "event-deleted", eventId: params.eventId });
      return json({ ok: true });
    }

    params = routeMatch(pathname, "/api/mobile/events/:eventIdOrCode");
    if (params && request.method === "GET") {
      const event = this.findEventByIdOrCode(params.eventIdOrCode);
      if (!event) return json({ error: "Not found" }, 404);
      return json({ event });
    }

    params = routeMatch(pathname, "/api/events/:eventId/runners");
    if (params && request.method === "GET") {
      if (!this.ensureEvent(params.eventId)) return json({ error: "Not found" }, 404);
      const runners = this.store.runners[params.eventId] || [];
      return json({ runners: runnersForResponse(runners, this.requireAdmin(request)) });
    }

    if (params && request.method === "POST") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      if (!this.ensureEvent(params.eventId)) return json({ error: "Not found" }, 404);
      const body = await readJson(request);
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
      this.store.runners[params.eventId] = this.store.runners[params.eventId] || [];
      this.store.runners[params.eventId].push(runner);
      await this.save();
      this.broadcast({ type: "runner-created", runner });
      return json({ runner }, 201);
    }

    params = routeMatch(pathname, "/api/events/:eventId/runners/:runnerId");
    if (params && request.method === "PUT") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      if (!this.ensureEvent(params.eventId)) return json({ error: "Not found" }, 404);
      const runner = (this.store.runners[params.eventId] || []).find(item => item.id === params.runnerId);
      if (!runner) return json({ error: "Not found" }, 404);
      const body = await readJson(request);
      runner.name = body.name || runner.name;
      runner.status = body.status || runner.status || "active";
      runner.updatedAt = nowIso();
      await this.save();
      this.broadcast({ type: "runner-updated", runner });
      return json({ runner });
    }

    if (params && request.method === "DELETE") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      if (!this.ensureEvent(params.eventId)) return json({ error: "Not found" }, 404);
      const runner = (this.store.runners[params.eventId] || []).find(item => item.id === params.runnerId);
      if (!runner) return json({ error: "Not found" }, 404);
      this.store.runners[params.eventId] = (this.store.runners[params.eventId] || []).filter(item => item.id !== params.runnerId);
      this.store.locationPoints = this.store.locationPoints.filter(point => point.runnerId !== params.runnerId);
      delete this.store.liveStates[params.runnerId];
      await this.save();
      this.broadcast({ type: "runner-deleted", runnerId: params.runnerId });
      return json({ ok: true });
    }

    if (pathname === "/api/mobile/join" && request.method === "POST") {
      const body = await readJson(request);
      const event = this.findEventByIdOrCode(body.eventId || body.eventCode);
      if (!event) return json({ error: "Not found" }, 404);
      const runners = this.store.runners[event.id] || [];
      let runner = body.deviceId ? runners.find(item => item.deviceId === body.deviceId) : null;
      if (!runner) {
        runner = {
          id: id("runner"),
          eventId: event.id,
          name: body.name || "未命名",
          deviceId: body.deviceId || "",
          uploadToken: id("token"),
          status: "active",
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        this.store.runners[event.id] = runners;
        runners.push(runner);
      } else {
        runner.name = body.name || runner.name;
        runner.updatedAt = nowIso();
      }
      await this.save();
      this.broadcast({ type: "runner-updated", runner: publicRunner(runner) });
      return json({ event, runner });
    }

    if (pathname === "/api/location/report" && request.method === "POST") {
      const body = await readJson(request);
      const point = this.normalizeAndValidatePoint(body);
      if (!point) return json({ error: "Invalid upload token" }, 403);
      this.appendPoint(point);
      await this.save();
      this.broadcast({ type: "location", point, liveStates: this.liveSnapshot(point.eventId) });
      return json({ point }, 201);
    }

    if (pathname === "/api/location/batch-report" && request.method === "POST") {
      const body = await readJson(request);
      const rawPoints = Array.isArray(body.points) ? body.points : [];
      const points = [];
      for (const rawPoint of rawPoints) {
        const point = this.normalizeAndValidatePoint({
          ...rawPoint,
          uploadToken: rawPoint.uploadToken || body.uploadToken
        });
        if (!point) return json({ error: "Invalid upload token" }, 403);
        points.push(point);
      }
      for (const point of points) {
        this.appendPoint(point);
        this.broadcast({ type: "location", point, liveStates: this.liveSnapshot(point.eventId) });
      }
      await this.save();
      return json({ points }, 201);
    }

    params = routeMatch(pathname, "/api/events/:eventId/live");
    if (params && request.method === "GET") {
      return json({ liveStates: this.liveSnapshot(params.eventId) });
    }

    params = routeMatch(pathname, "/api/events/:eventId/runners/:runnerId/track");
    if (params && request.method === "GET") {
      const track = this.store.locationPoints.filter(point => point.eventId === params.eventId && point.runnerId === params.runnerId);
      return json({ track });
    }

    params = routeMatch(pathname, "/api/events/:eventId/map-image");
    if (params && request.method === "GET") {
      return json({ mapImage: this.store.mapImages[params.eventId] || null });
    }

    if (params && request.method === "POST") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      if (!this.ensureEvent(params.eventId)) return json({ error: "Not found" }, 404);
      const body = await readJson(request);
      if (!body.dataBase64 || !body.mimeType) return json({ error: "dataBase64 and mimeType are required" }, 400);
      let imageUrl = `data:${body.mimeType};base64,${body.dataBase64}`;
      let imageKey = "";
      if (this.env.MAPS) {
        const ext = extensionForMime(body.mimeType);
        imageKey = `maps/${params.eventId}/${Date.now()}.${ext}`;
        await this.env.MAPS.put(imageKey, bytesFromBase64(body.dataBase64), {
          httpMetadata: { contentType: body.mimeType }
        });
        imageUrl = `/api/maps/${imageKey}`;
      }
      const mapImage = {
        id: id("map"),
        eventId: params.eventId,
        imageUrl,
        imageKey,
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
      this.store.mapImages[params.eventId] = mapImage;
      await this.save();
      return json({ mapImage }, 201);
    }

    params = routeMatch(pathname, "/api/events/:eventId/map-transform");
    if (params && request.method === "PUT") {
      if (!this.requireAdmin(request)) return json({ error: "Admin password required" }, 401);
      if (!this.ensureEvent(params.eventId)) return json({ error: "Not found" }, 404);
      const existing = this.store.mapImages[params.eventId];
      if (!existing) return json({ error: "Upload a map image before saving transform" }, 400);
      const body = await readJson(request);
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
      this.store.mapImages[params.eventId] = mapImage;
      await this.save();
      this.broadcast({ type: "map-transform", mapImage });
      return json({ mapImage });
    }

    params = routeMatch(pathname, "/ws/events/:eventId/live");
    if (params && request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.clients.add(server);
      server.send(JSON.stringify({ type: "snapshot", liveStates: this.liveSnapshot(params.eventId), mapImage: this.store.mapImages[params.eventId] || null }));
      server.addEventListener("close", () => this.clients.delete(server));
      server.addEventListener("error", () => this.clients.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "Not implemented in Cloudflare worker yet" }, 501);
  }
}
