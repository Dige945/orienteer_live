const assert = require("assert");

const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const argBase = args.find(arg => !arg.startsWith("--"));
const rawBase = process.env.CF_BASE || process.env.BASE_URL || argBase;
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

if (!rawBase) {
  console.error("Usage: node scripts/cloudflare-smoke.js <https://your-domain> [--write]");
  console.error("Or set CF_BASE=https://your-domain");
  process.exit(1);
}

const base = rawBase.replace(/\/+$/, "");

async function json(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function expectStatus(path, status, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (res.status !== status) {
    const text = await res.text();
    throw new Error(`Expected ${status} for ${path}, got ${res.status}: ${text}`);
  }
}

async function adminJson(path, options = {}) {
  return json(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-admin-password": adminPassword
    }
  });
}

async function readOnlySmoke() {
  const health = await json("/api/health");
  assert.strictEqual(health.ok, true);

  const diagnostics = await json("/api/diagnostics");
  assert.strictEqual(diagnostics.ok, true);

  const login = await json("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ password: adminPassword })
  });
  assert.strictEqual(login.ok, true);

  const events = await json("/api/events");
  assert(Array.isArray(events.events));

  if (events.events[0]) {
    const eventId = events.events[0].id;
    const event = await json(`/api/events/${eventId}`);
    assert.strictEqual(event.event.id, eventId);
    const runners = await json(`/api/events/${eventId}/runners`);
    assert(runners.runners.every(runner => !("uploadToken" in runner)));
    await json(`/api/events/${eventId}/live`);
    await json(`/api/events/${eventId}/map-image`);
  }

  console.log(`cloudflare smoke ok: ${base}`);
  console.log("mode: read-only");
}

async function writeSmoke() {
  await readOnlySmoke();

  await expectStatus("/api/events", 401, {
    method: "POST",
    body: JSON.stringify({ name: "blocked" })
  });

  const created = await adminJson("/api/events", {
    method: "POST",
    body: JSON.stringify({ name: "cloudflare smoke", description: "automated write test" })
  });
  assert(created.event.id);
  assert(created.event.code);

  const updatedEvent = await adminJson(`/api/events/${created.event.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: "cloudflare smoke updated", description: "managed" })
  });
  assert.strictEqual(updatedEvent.event.name, "cloudflare smoke updated");

  const joined = await json("/api/mobile/join", {
    method: "POST",
    body: JSON.stringify({
      eventCode: created.event.code,
      name: "runner smoke",
      deviceId: "cloudflare-smoke-device"
    })
  });
  assert.strictEqual(joined.event.id, created.event.id);
  assert(joined.runner.uploadToken);

  const renamed = await json("/api/mobile/join", {
    method: "POST",
    body: JSON.stringify({
      eventCode: created.event.code,
      name: "runner renamed",
      deviceId: "cloudflare-smoke-device"
    })
  });
  assert.strictEqual(renamed.runner.id, joined.runner.id);
  assert.strictEqual(renamed.runner.name, "runner renamed");

  const manualRunner = await adminJson(`/api/events/${created.event.id}/runners`, {
    method: "POST",
    body: JSON.stringify({ name: "manual runner" })
  });
  assert(manualRunner.runner.id);

  const updatedRunner = await adminJson(`/api/events/${created.event.id}/runners/${manualRunner.runner.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: "manual renamed" })
  });
  assert.strictEqual(updatedRunner.runner.name, "manual renamed");

  await adminJson(`/api/events/${created.event.id}/runners/${manualRunner.runner.id}`, { method: "DELETE" });
  const publicRunners = await json(`/api/events/${created.event.id}/runners`);
  assert(publicRunners.runners.every(runner => !("uploadToken" in runner)));
  const adminRunners = await adminJson(`/api/events/${created.event.id}/runners`);
  assert(adminRunners.runners.some(runner => runner.uploadToken === joined.runner.uploadToken));

  const uploadedMap = await adminJson(`/api/events/${created.event.id}/map-image`, {
    method: "POST",
    body: JSON.stringify({
      dataBase64: "iVBORw0KGgo=",
      mimeType: "image/png",
      imageWidth: 100,
      imageHeight: 100
    })
  });
  assert(uploadedMap.mapImage.imageUrl);

  const transform = await adminJson(`/api/events/${created.event.id}/map-transform`, {
    method: "PUT",
    body: JSON.stringify({
      anchorLng: 120.1,
      anchorLat: 30.1,
      offsetX: 4,
      offsetY: -3,
      scale: 1.1,
      rotation: 12,
      opacity: 0.6,
      zoom: 16,
      provider: "osm",
      overlayWidth: 800,
      calibration: {
        provider: "osm",
        zoom: 16,
        mapPoints: [{ lng: 120.1, lat: 30.1 }, { lng: 120.101, lat: 30.101 }],
        imagePoints: [{ imageX: 10, imageY: 20 }, { imageX: 90, imageY: 80 }]
      }
    })
  });
  assert.strictEqual(transform.mapImage.calibration.mapPoints.length, 2);

  await json("/api/location/report", {
    method: "POST",
    body: JSON.stringify({
      eventId: created.event.id,
      runnerId: joined.runner.id,
      uploadToken: joined.runner.uploadToken,
      lat: 30.1001,
      lng: 120.1001,
      coordSystem: "WGS84",
      accuracy: 8,
      speed: 2,
      heading: 90,
      timestamp: Date.now()
    })
  });

  await json("/api/location/batch-report", {
    method: "POST",
    body: JSON.stringify({
      points: [{
        eventId: created.event.id,
        runnerId: joined.runner.id,
        uploadToken: joined.runner.uploadToken,
        lat: 30.1002,
        lng: 120.1002,
        coordSystem: "WGS84",
        accuracy: 7,
        speed: 2,
        heading: 91,
        timestamp: Date.now() + 1
      }]
    })
  });

  const live = await json(`/api/events/${created.event.id}/live`);
  assert.strictEqual(live.liveStates.length, 1);

  const track = await json(`/api/events/${created.event.id}/runners/${joined.runner.id}/track`);
  assert.strictEqual(track.track.length, 2);

  await adminJson(`/api/events/${created.event.id}`, { method: "DELETE" });
  const eventsAfterDelete = await json("/api/events");
  assert.strictEqual(eventsAfterDelete.events.length, 0);

  console.log("mode: write");
}

(writeMode ? writeSmoke() : readOnlySmoke()).catch(error => {
  console.error(error);
  process.exit(1);
});
