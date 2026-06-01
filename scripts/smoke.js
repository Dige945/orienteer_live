const assert = require("assert");
const { spawn } = require("child_process");

const port = 3100 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const adminPassword = "admin123";

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function json(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
  return body;
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

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const health = await json("/api/health");
      if (health.ok) return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("server did not start");
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit"
  });

  try {
    await waitForServer();
    const diagnostics = await json("/api/diagnostics");
    assert.strictEqual(diagnostics.ok, true);
    assert.strictEqual(diagnostics.uploadsWritable, true);

    const login = await json("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: adminPassword })
    });
    assert.strictEqual(login.ok, true);

    await assert.rejects(
      () => json("/api/events", {
        method: "POST",
        body: JSON.stringify({ name: "blocked" })
      }),
      /401/
    );

    const created = await adminJson("/api/events", {
      method: "POST",
      body: JSON.stringify({ name: "smoke", description: "automated" })
    });
    assert(created.event.id);
    assert(created.event.code);

    const updatedEvent = await adminJson(`/api/events/${created.event.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "smoke updated", description: "managed" })
    });
    assert.strictEqual(updatedEvent.event.name, "smoke updated");
    assert.strictEqual(updatedEvent.event.description, "managed");

    const replaced = await adminJson("/api/events", {
      method: "POST",
      body: JSON.stringify({ name: "smoke replacement", description: "single event mode" })
    });
    assert(replaced.event.id);
    assert.notStrictEqual(replaced.event.id, created.event.id);
    const eventsAfterReplace = await json("/api/events");
    assert.strictEqual(eventsAfterReplace.events.length, 1);
    assert.strictEqual(eventsAfterReplace.events[0].id, replaced.event.id);

    const joined = await json("/api/mobile/join", {
      method: "POST",
      body: JSON.stringify({
        eventCode: replaced.event.code,
        name: "runner smoke",
        deviceId: "smoke-device"
      })
    });
    assert.strictEqual(joined.event.id, replaced.event.id);
    assert(joined.runner.id);
    assert.strictEqual(joined.runner.name, "runner smoke");

    const renamed = await json("/api/mobile/join", {
      method: "POST",
      body: JSON.stringify({
        eventCode: replaced.event.code,
        name: "runner renamed",
        deviceId: "smoke-device"
      })
    });
    assert.strictEqual(renamed.runner.id, joined.runner.id);
    assert.strictEqual(renamed.runner.name, "runner renamed");

    const manualRunner = await adminJson(`/api/events/${replaced.event.id}/runners`, {
      method: "POST",
      body: JSON.stringify({ name: "manual runner" })
    });
    assert(manualRunner.runner.id);

    const updatedRunner = await adminJson(`/api/events/${replaced.event.id}/runners/${manualRunner.runner.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "manual renamed" })
    });
    assert.strictEqual(updatedRunner.runner.name, "manual renamed");

    await adminJson(`/api/events/${replaced.event.id}/runners/${manualRunner.runner.id}`, { method: "DELETE" });
    const runnersAfterDelete = await json(`/api/events/${replaced.event.id}/runners`);
    assert(!runnersAfterDelete.runners.some(runner => runner.id === manualRunner.runner.id));
    assert(!("uploadToken" in runnersAfterDelete.runners[0]));

    const adminRunners = await adminJson(`/api/events/${replaced.event.id}/runners`);
    assert.strictEqual(adminRunners.runners[0].uploadToken, joined.runner.uploadToken);

    await adminJson(`/api/events/${replaced.event.id}/map-image`, {
      method: "POST",
      body: JSON.stringify({
        dataBase64: "iVBORw0KGgo=",
        mimeType: "image/png",
        imageWidth: 100,
        imageHeight: 100
      })
    });

    const transform = await adminJson(`/api/events/${replaced.event.id}/map-transform`, {
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
        provider: "amap",
        calibration: {
          provider: "amap",
          zoom: 16,
          mapPoints: [{ lng: 120.1, lat: 30.1 }, { lng: 120.101, lat: 30.101 }],
          imagePoints: [{ imageX: 10, imageY: 20 }, { imageX: 90, imageY: 80 }]
        },
        overlayWidth: 800
      })
    });
    assert.strictEqual(transform.mapImage.zoom, 16);
    assert.strictEqual(transform.mapImage.provider, "amap");
    assert.strictEqual(transform.mapImage.calibration.mapPoints.length, 2);
    assert.strictEqual(transform.mapImage.overlayWidth, 800);

    await json("/api/location/report", {
      method: "POST",
      body: JSON.stringify({
        eventId: replaced.event.id,
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
        points: [
          {
            eventId: replaced.event.id,
            runnerId: joined.runner.id,
            uploadToken: joined.runner.uploadToken,
            lat: 30.1002,
            lng: 120.1002,
            coordSystem: "WGS84",
            accuracy: 7,
            speed: 2,
            heading: 91,
            timestamp: Date.now() + 1
          }
        ]
      })
    });

    const live = await json(`/api/events/${replaced.event.id}/live`);
    assert.strictEqual(live.liveStates.length, 1);
    assert.strictEqual(live.liveStates[0].isOnline, true);

    const track = await json(`/api/events/${replaced.event.id}/runners/${joined.runner.id}/track`);
    assert.strictEqual(track.track.length, 2);

    await json("/api/location/report", {
      method: "POST",
      body: JSON.stringify({
        eventId: replaced.event.id,
        runnerId: joined.runner.id,
        uploadToken: joined.runner.uploadToken,
        lat: 31.2,
        lng: 121.2,
        coordSystem: "WGS84",
        accuracy: 80,
        speed: 0,
        heading: 0,
        timestamp: Date.now() + 2
      })
    });

    const liveAfterJump = await json(`/api/events/${replaced.event.id}/live`);
    assert.strictEqual(liveAfterJump.liveStates[0].latestLat, live.liveStates[0].latestLat);
    assert.strictEqual(liveAfterJump.liveStates[0].rejectedCount, 1);

    await adminJson(`/api/events/${replaced.event.id}`, { method: "DELETE" });
    const eventsAfterDelete = await json("/api/events");
    assert.strictEqual(eventsAfterDelete.events.length, 0);

    console.log("smoke ok");
  } finally {
    child.kill();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
