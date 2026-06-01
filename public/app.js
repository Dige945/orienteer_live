const state = {
  events: [],
  selectedEventId: null,
  mapImage: null,
  runners: [],
  liveStates: [],
  tracks: {},
  showTracks: true,
  liveRefreshTimer: null,
  isAdmin: false,
  adminPassword: localStorage.getItem("adminPassword") || "",
  playback: {
    runnerId: "",
    selectedRunnerIds: new Set(),
    speed: 1,
    index: 0,
    playing: false,
    timer: null
  },
  transform: {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    rotation: 0,
    opacity: 0.65
  },
  drag: null,
  calibrationMode: null,
  calibration: {
    mapPoints: [],
    imagePoints: []
  },
  ws: null,
  liveView: {
    scale: 1,
    x: 0,
    y: 0,
    drag: null
  },
  tileMap: {
    centerLng: 120.123456,
    centerLat: 30.123456,
    zoom: 16,
    provider: "osm",
    marker: null,
    drag: null
  }
};

const $ = selector => document.querySelector(selector);
const LIVE_TRAIL_MS = 20 * 1000;
const RUNNER_COLORS = ["#d97706", "#0f766e", "#2563eb", "#be123c", "#7c3aed", "#15803d", "#b45309", "#0891b2", "#c2410c", "#4f46e5"];
const A = 6378245.0;
const EE = 0.00669342162296594323;

const api = async (path, options = {}) => {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.adminPassword) headers["x-admin-password"] = state.adminPassword;
  const response = await fetch(path, {
    headers,
    ...options
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
};

function selectedEvent() {
  return state.events.find(event => event.id === state.selectedEventId);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function eventStatusText(status) {
  return {
    draft: "草稿",
    active: "进行中",
    closed: "已结束"
  }[status] || status || "草稿";
}

function setStatus(text, ok = false) {
  const el = $("#serverStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("ok", ok);
}

function applyAdminMode() {
  document.body.classList.toggle("admin-mode", state.isAdmin);
  document.body.classList.toggle("visitor-mode", !state.isAdmin);
  if (!state.isAdmin) showTab("live");
  renderEvents();
  renderRunners();
}

async function loginAdmin() {
  const password = prompt("请输入管理员密码");
  if (!password) return;
  const previous = state.adminPassword;
  state.adminPassword = password;
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    localStorage.setItem("adminPassword", password);
    state.isAdmin = true;
    applyAdminMode();
    if (state.selectedEventId) await selectEvent(state.selectedEventId, false);
    showTab("align");
  } catch {
    state.adminPassword = previous;
    alert("管理员密码不正确");
  }
}

function logoutAdmin() {
  state.adminPassword = "";
  state.isAdmin = false;
  localStorage.removeItem("adminPassword");
  applyAdminMode();
}

function showTab(tabName) {
  document.querySelectorAll(".tab[data-tab], .tab-view").forEach(el => el.classList.remove("active"));
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const view = $(`#${tabName}View`);
  if (tab) tab.classList.add("active");
  if (view) view.classList.add("active");
  renderLiveOverlay();
}

function renderEvents() {
  const list = $("#eventList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.events.length) {
    list.innerHTML = `<div class="event-item"><strong>暂无赛事</strong><small>创建赛事后，网页和手机二维码都会指向这个赛事。</small></div>`;
    return;
  }
  state.events.forEach(event => {
    const item = document.createElement("div");
    item.className = `event-item ${event.id === state.selectedEventId ? "active" : ""}`;
    item.innerHTML = `
      <strong>${escapeHtml(event.name)}</strong>
      <small>当前赛事 · 赛事码 ${escapeHtml(event.code || "--")} · ${eventStatusText(event.status)}</small>
      <div class="item-actions">
        <button type="button" class="ghost-button" data-action="edit">修改</button>
        <button type="button" class="danger-button" data-action="delete">删除</button>
      </div>
    `;
    item.addEventListener("click", () => selectEvent(event.id));
    item.querySelector('[data-action="edit"]').addEventListener("click", click => {
      click.stopPropagation();
      editEvent(event);
    });
    item.querySelector('[data-action="delete"]').addEventListener("click", click => {
      click.stopPropagation();
      deleteEvent(event);
    });
    list.appendChild(item);
  });
}

function renderRunners() {
  const list = $("#runnerList");
  if (!list) return;
  list.innerHTML = "";
  state.runners.forEach(runner => {
    const item = document.createElement("div");
    item.className = "runner-item";
    item.innerHTML = `
      <strong>${escapeHtml(runner.name)}</strong>
      <small>${runner.status === "active" ? "参赛中" : escapeHtml(runner.status || "参赛中")}</small>
      <div class="item-actions">
        <button type="button" class="ghost-button" data-action="edit">改名</button>
        <button type="button" class="danger-button" data-action="delete">删除</button>
      </div>
    `;
    item.querySelector('[data-action="edit"]').addEventListener("click", () => editRunner(runner));
    item.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRunner(runner));
    list.appendChild(item);
  });
  renderPlaybackOptions();
}

async function editEvent(event) {
  const name = prompt("请输入新的赛事名称", event.name || "");
  if (name === null) return;
  const description = prompt("请输入赛事备注", event.description || "");
  if (description === null) return;
  const data = await api(`/api/events/${event.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: name.trim() || event.name,
      description
    })
  });
  state.events = state.events.map(item => item.id === data.event.id ? data.event : item);
  renderEvents();
  renderApiExample();
}

async function deleteEvent(event) {
  if (!confirm(`确定删除赛事“${event.name}”吗？参赛者和轨迹也会一起删除。`)) return;
  await api(`/api/events/${event.id}`, { method: "DELETE" });
  if (state.selectedEventId === event.id) state.selectedEventId = null;
  await refreshEvents();
}

async function editRunner(runner) {
  if (!state.selectedEventId) return;
  const name = prompt("请输入新的参赛者姓名", runner.name || "");
  if (name === null) return;
  const data = await api(`/api/events/${state.selectedEventId}/runners/${runner.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: name.trim() || runner.name })
  });
  state.runners = state.runners.map(item => item.id === data.runner.id ? data.runner : item);
  renderRunners();
  renderLiveOverlay();
}

async function deleteRunner(runner) {
  if (!state.selectedEventId) return;
  if (!confirm(`确定删除参赛者“${runner.name}”吗？这个人的轨迹也会一起删除。`)) return;
  await api(`/api/events/${state.selectedEventId}/runners/${runner.id}`, { method: "DELETE" });
  state.runners = state.runners.filter(item => item.id !== runner.id);
  state.liveStates = state.liveStates.filter(item => item.runnerId !== runner.id);
  delete state.tracks[runner.id];
  renderRunners();
  renderLiveOverlay();
}

function visibleRunners() {
  return state.runners;
}

function visibleRunnerIds() {
  return new Set(visibleRunners().map(runner => runner.id));
}

function colorForRunner(runnerId) {
  let hash = 0;
  for (const char of String(runnerId || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return RUNNER_COLORS[Math.abs(hash) % RUNNER_COLORS.length];
}

function renderApiExample() {
  const event = selectedEvent();
  const serverOrigin = $("#serverOrigin");
  const configuredOrigin = (serverOrigin?.value || location.origin).trim().replace(/\/$/, "");
  if (serverOrigin && configuredOrigin) localStorage.setItem("appServerUrl", configuredOrigin);
  const diagnostics = $("#diagnosticsLink");
  if (diagnostics) diagnostics.href = `${configuredOrigin}/api/diagnostics`;
  const deepLink = event?.code
    ? `orienteer://join?code=${encodeURIComponent(event.code)}&server=${encodeURIComponent(configuredOrigin)}`
    : "";
  const joinInput = $("#joinLink");
  if (joinInput) joinInput.value = deepLink;
  const qr = $("#joinQr");
  if (qr) {
    qr.style.display = deepLink ? "block" : "none";
    qr.src = deepLink
      ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(deepLink)}`
      : "";
  }
  $("#apiExample").textContent = JSON.stringify({
    deepLink: deepLink || "请先创建或选择赛事",
    join: {
      method: "POST",
      url: `${location.origin}/api/mobile/join`,
      body: {
        eventId: event?.id || "event-id",
        eventCode: event?.code || "ABC123",
        name: "张三",
        deviceId: "android-device-uuid"
      }
    },
    report: {
      method: "POST",
      url: `${location.origin}/api/location/report`,
      body: {
        eventId: event?.id || "event-id",
        runnerId: "runner-id-from-join",
        uploadToken: "upload-token-from-join",
        lat: 30.123456,
        lng: 120.123456,
        coordSystem: "WGS84",
        accuracy: 8.5,
        speed: 2.1,
        heading: 86,
        timestamp: Date.now()
      }
    },
    batchReport: {
      method: "POST",
      url: `${location.origin}/api/location/batch-report`,
      body: {
        points: [
          {
            eventId: event?.id || "event-id",
            runnerId: "runner-id-from-join",
            uploadToken: "upload-token-from-join",
            lat: 30.123456,
            lng: 120.123456,
            coordSystem: "WGS84",
            accuracy: 8.5,
            speed: 2.1,
            heading: 86,
            timestamp: Date.now()
          }
        ]
      }
    }
  }, null, 2);
}

function defaultServerOrigin() {
  const saved = localStorage.getItem("appServerUrl") || "";
  const isOldTemporaryUrl = /trycloudflare\.com|localhost|127\.0\.0\.1|192\.168\.|10\./i.test(saved);
  return saved && !isOldTemporaryUrl ? saved : location.origin;
}

function applyTransform() {
  const image = $("#overlayImage");
  const { offsetX, offsetY, scale, rotation, opacity } = state.transform;
  image.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${scale}) rotate(${rotation}deg)`;
  image.style.opacity = opacity;
  $("#scaleInput").value = scale;
  $("#rotationInput").value = rotation;
  $("#opacityInput").value = opacity;
}

function setReferenceMapVisible(visible) {
  $("#tileMap").style.opacity = visible ? "1" : "0";
  $("#tileMap").style.pointerEvents = visible ? "auto" : "none";
}

function loadMapImage(mapImage) {
  state.mapImage = mapImage;
  if (!mapImage) return;
  state.transform = {
    offsetX: mapImage.offsetX || 0,
    offsetY: mapImage.offsetY || 0,
    scale: mapImage.scale || 1,
    rotation: mapImage.rotation || 0,
    opacity: mapImage.opacity || 0.65
  };
  if (mapImage.provider) {
    state.tileMap.provider = mapImage.provider;
    const providerSelect = $("#mapProvider");
    if (providerSelect) providerSelect.value = mapImage.provider;
  }
  const overlay = $("#overlayImage");
  overlay.src = mapImage.imageUrl;
  overlay.style.display = "block";
  overlay.onload = () => {
    overlay.style.width = `${mapImage.overlayWidth || Math.min(overlay.naturalWidth, 900)}px`;
    renderLiveMap();
    renderAlignOverlay();
  };
  applyTransform();
  if (mapImage.anchorLng && mapImage.anchorLat) {
    setMapCenter(mapImage.anchorLng, mapImage.anchorLat, mapImage.zoom || state.tileMap.zoom);
  }
}

function updateMapReadout() {
  const readout = $("#mapReadout");
  if (!readout) return;
  $("#centerLng").value = Number(state.tileMap.centerLng).toFixed(6);
  $("#centerLat").value = Number(state.tileMap.centerLat).toFixed(6);
  const providerName = state.tileMap.provider === "amap" ? "高德" : "OSM";
  readout.textContent = `${providerName}地图中心 ${Number(state.tileMap.centerLng).toFixed(6)}, ${Number(state.tileMap.centerLat).toFixed(6)} · 缩放 ${state.tileMap.zoom}。保存对齐后，手机 GPS 会映射到定向底图上。`;
  const debug = $("#mapDebug");
  if (debug) {
    const rect = $("#tileMap").getBoundingClientRect();
    debug.textContent = `${providerName}参考瓦片 · 容器 ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }
}

function setMapCenter(lng, lat, zoom = null) {
  state.tileMap.centerLng = Number(lng);
  state.tileMap.centerLat = Number(lat);
  if (zoom) state.tileMap.zoom = Number(zoom);
  state.tileMap.marker = { lng: Number(lng), lat: Number(lat) };
  renderTileMap();
  updateMapReadout();
}

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin(lat / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(lat / 12.0 * Math.PI) + 320 * Math.sin(lat * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin(lng / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(lng / 12.0 * Math.PI) + 300.0 * Math.sin(lng / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return {
    lng: lng + dLng,
    lat: lat + dLat
  };
}

function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  const gcj = wgs84ToGcj02(lng, lat);
  return {
    lng: lng * 2 - gcj.lng,
    lat: lat * 2 - gcj.lat
  };
}

function displayLngLat(lng, lat, provider = state.tileMap.provider) {
  return provider === "amap" ? wgs84ToGcj02(Number(lng), Number(lat)) : { lng: Number(lng), lat: Number(lat) };
}

function sourceLngLatFromDisplay(lng, lat, provider = state.tileMap.provider) {
  return provider === "amap" ? gcj02ToWgs84(Number(lng), Number(lat)) : { lng: Number(lng), lat: Number(lat) };
}

function renderPlaceResults(pois) {
  const list = $("#placeResults");
  list.innerHTML = "";
  if (!pois.length) {
    list.innerHTML = `<div class="place-item">没有搜索结果</div>`;
    return;
  }
  pois.slice(0, 8).forEach(poi => {
    const item = document.createElement("div");
    item.className = "place-item";
    item.innerHTML = `<strong>${poi.display_name || poi.name}</strong><small>${poi.lat}, ${poi.lon}</small>`;
    item.addEventListener("click", () => {
      setMapCenter(Number(poi.lon), Number(poi.lat), 17);
    });
    list.appendChild(item);
  });
}

async function searchPlace() {
  const keyword = $("#placeKeyword").value.trim();
  if (!keyword) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=8&q=${encodeURIComponent(keyword)}`);
    if (!res.ok) return renderPlaceResults([]);
    renderPlaceResults(await res.json());
  } catch {
    const list = $("#placeResults");
    list.innerHTML = `<div class="place-item">搜索失败，可以手动输入经纬度。</div>`;
  }
}

function renderTileMap() {
  const map = $("#tileMap");
  if (!map) return;
  const rect = map.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const zoom = state.tileMap.zoom;
  const center = lngLatToWorld(state.tileMap.centerLng, state.tileMap.centerLat, zoom);
  const startX = Math.floor((center.x - rect.width / 2) / 256);
  const endX = Math.floor((center.x + rect.width / 2) / 256);
  const startY = Math.floor((center.y - rect.height / 2) / 256);
  const endY = Math.floor((center.y + rect.height / 2) / 256);
  const max = Math.pow(2, zoom);
  map.innerHTML = "";
  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      if (y < 0 || y >= max) continue;
      const tileX = ((x % max) + max) % max;
      const img = document.createElement("img");
      img.className = "map-tile";
      img.draggable = false;
      img.src = tileUrl(state.tileMap.provider, zoom, tileX, y);
      img.onerror = () => {
        const debug = $("#mapDebug");
        if (debug) debug.textContent = "参考地图瓦片加载失败，请检查网络，或切换 OSM/高德。";
      };
      img.style.left = `${x * 256 - center.x + rect.width / 2}px`;
      img.style.top = `${y * 256 - center.y + rect.height / 2}px`;
      map.appendChild(img);
    }
  }
  if (state.tileMap.marker) {
    const markerWorld = lngLatToWorld(state.tileMap.marker.lng, state.tileMap.marker.lat, zoom);
    const marker = document.createElement("div");
    marker.className = "tile-marker";
    marker.style.left = `${markerWorld.x - center.x + rect.width / 2}px`;
    marker.style.top = `${markerWorld.y - center.y + rect.height / 2}px`;
    map.appendChild(marker);
  }
  renderAlignOverlay();
}

function tileUrl(provider, zoom, x, y) {
  if (provider === "amap") {
    const server = 1 + ((x + y) % 4);
    return `https://webrd0${server}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x=${x}&y=${y}&z=${zoom}`;
  }
  return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
}

function renderLiveMap() {
  const image = $("#liveMapImage");
  const empty = $("#liveEmpty");
  if (!state.mapImage) {
    image.style.display = "none";
    empty.style.display = "grid";
    return;
  }
  image.src = state.mapImage.imageUrl;
  image.style.display = "block";
  empty.style.display = state.liveStates.length ? "none" : "grid";
  renderLiveOverlay();
}

function alignReferencePointFor(locationState) {
  return referencePointForLngLat(locationState.latestLng, locationState.latestLat);
}

function referencePointForLngLat(lng, lat) {
  const map = $("#tileMap");
  if (!map) return null;
  const rect = map.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const zoom = state.tileMap.zoom;
  const center = lngLatToWorld(state.tileMap.centerLng, state.tileMap.centerLat, zoom);
  const targetCoord = displayLngLat(lng, lat, state.tileMap.provider);
  const target = lngLatToWorld(targetCoord.lng, targetCoord.lat, zoom);
  return {
    x: target.x - center.x + rect.width / 2,
    y: target.y - center.y + rect.height / 2
  };
}

function mapImageNaturalPointForClient(clientX, clientY) {
  const metrics = baseImageMetrics();
  const stage = $("#alignStage");
  if (!metrics || !stage) return null;
  const stageRect = stage.getBoundingClientRect();
  const stageX = clientX - stageRect.left;
  const stageY = clientY - stageRect.top;
  const scale = state.transform.scale || 1;
  const rad = (state.transform.rotation || 0) * Math.PI / 180;
  const dx = stageX - metrics.centerX - (state.transform.offsetX || 0);
  const dy = stageY - metrics.centerY - (state.transform.offsetY || 0);
  const unrotatedX = (dx * Math.cos(rad) + dy * Math.sin(rad)) / scale;
  const unrotatedY = (-dx * Math.sin(rad) + dy * Math.cos(rad)) / scale;
  const baseX = metrics.centerX + unrotatedX;
  const baseY = metrics.centerY + unrotatedY;
  const x = ((baseX - metrics.left) / metrics.width) * metrics.naturalWidth;
  const y = ((baseY - metrics.top) / metrics.height) * metrics.naturalHeight;
  if (x < 0 || y < 0 || x > metrics.naturalWidth || y > metrics.naturalHeight) return null;
  return { x, y };
}

function baseImageMetrics() {
  const image = $("#overlayImage");
  const stage = $("#alignStage");
  if (!image || !stage || !image.naturalWidth || !image.naturalHeight) return null;
  const stageRect = stage.getBoundingClientRect();
  const width = image.offsetWidth || state.mapImage?.overlayWidth || image.naturalWidth;
  const height = width * image.naturalHeight / image.naturalWidth;
  return {
    centerX: stageRect.width / 2,
    centerY: stageRect.height / 2,
    left: stageRect.width / 2 - width / 2,
    top: stageRect.height / 2 - height / 2,
    width,
    height,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight
  };
}

function baseImagePoint(naturalPoint) {
  const metrics = baseImageMetrics();
  if (!metrics) return null;
  return {
    x: metrics.left + (naturalPoint.imageX / metrics.naturalWidth) * metrics.width,
    y: metrics.top + (naturalPoint.imageY / metrics.naturalHeight) * metrics.height,
    metrics
  };
}

function transformedImagePoint(naturalPoint) {
  const base = baseImagePoint(naturalPoint);
  if (!base) return null;
  const { metrics } = base;
  const scale = state.transform.scale || 1;
  const rad = (state.transform.rotation || 0) * Math.PI / 180;
  const dx = base.x - metrics.centerX;
  const dy = base.y - metrics.centerY;
  return {
    x: metrics.centerX + (state.transform.offsetX || 0) + scale * (dx * Math.cos(rad) - dy * Math.sin(rad)),
    y: metrics.centerY + (state.transform.offsetY || 0) + scale * (dx * Math.sin(rad) + dy * Math.cos(rad))
  };
}

function startMapPointCapture() {
  setCalibrationMode("map");
  alert("请在公共地图上依次点击 1 号点和 2 号点。");
}

function startImagePointCapture() {
  if (state.calibration.mapPoints.length < 2) return alert("请先在公共地图上记录 1 号点和 2 号点");
  setCalibrationMode("image");
  alert("请在定向图上依次点击对应的 1 号点和 2 号点。");
}

function addMapCalibrationPoint(event) {
  if (state.calibration.mapPoints.length >= 2) {
    setCalibrationMode(null);
    return;
  }
  const rect = $("#tileMap").getBoundingClientRect();
  const zoom = state.tileMap.zoom;
  const center = lngLatToWorld(state.tileMap.centerLng, state.tileMap.centerLat, zoom);
  const worldX = center.x + event.clientX - rect.left - rect.width / 2;
  const worldY = center.y + event.clientY - rect.top - rect.height / 2;
  const lngLat = worldToLngLat(worldX, worldY, zoom);
  const point = {
    refX: event.clientX - rect.left,
    refY: event.clientY - rect.top,
    lng: lngLat.lng,
    lat: lngLat.lat
  };
  state.calibration.mapPoints.push(point);
  if (state.calibration.mapPoints.length >= 2) setCalibrationMode(null);
  renderAlignOverlay();
}

function addImageCalibrationPoint(event) {
  const target = mapImageNaturalPointForClient(event.clientX, event.clientY);
  if (!target) return alert("请点击定向图图片内部");
  if (state.calibration.imagePoints.length >= 2) {
    setCalibrationMode(null);
    return;
  }
  state.calibration.imagePoints.push({
    imageX: target.x,
    imageY: target.y
  });
  if (state.calibration.imagePoints.length >= 2) setCalibrationMode(null);
  renderAlignOverlay();
}

async function saveCurrentTransform() {
  if (!state.selectedEventId || !state.mapImage) throw new Error("请先上传底图");
  const overlay = $("#overlayImage");
  const data = await api(`/api/events/${state.selectedEventId}/map-transform`, {
    method: "PUT",
    body: JSON.stringify({
      ...state.transform,
      anchorLng: state.tileMap.centerLng,
      anchorLat: state.tileMap.centerLat,
      zoom: state.tileMap.zoom,
      provider: state.tileMap.provider,
      calibration: state.mapImage.calibration || null,
      overlayWidth: overlay.getBoundingClientRect().width / state.transform.scale
    })
  });
  loadMapImage(data.mapImage);
}

async function applyTwoPointCalibration() {
  if (state.calibration.mapPoints.length < 2) return alert("请先在公共地图上记录两个点");
  if (state.calibration.imagePoints.length < 2) return alert("请再在定向图上记录两个对应点");
  if (!state.mapImage) return alert("请先上传定向图");
  const image = $("#overlayImage");
  if (!image.naturalWidth || !image.naturalHeight) return alert("定向图还没有加载完成");

  const [mapA, mapB] = state.calibration.mapPoints;
  const [imageA, imageB] = state.calibration.imagePoints;
  const mapScreenA = referencePointForLngLat(mapA.lng, mapA.lat);
  const mapScreenB = referencePointForLngLat(mapB.lng, mapB.lat);
  if (!mapScreenA || !mapScreenB) return alert("无法读取地图控制点当前位置");
  const imgA = baseImagePoint(imageA);
  const imgB = baseImagePoint(imageB);
  if (!imgA || !imgB) return alert("无法读取底图控制点");
  const { metrics } = imgA;
  const source = { x: imgB.x - imgA.x, y: imgB.y - imgA.y };
  const target = { x: mapScreenB.x - mapScreenA.x, y: mapScreenB.y - mapScreenA.y };
  const sourceLen = Math.hypot(source.x, source.y);
  const targetLen = Math.hypot(target.x, target.y);
  if (sourceLen < 1 || targetLen < 1) return alert("两个控制点距离太近，请选远一点的点");

  const scale = targetLen / sourceLen;
  const rotation = (Math.atan2(target.y, target.x) - Math.atan2(source.y, source.x)) * 180 / Math.PI;
  const rad = rotation * Math.PI / 180;
  const ax = imgA.x - metrics.centerX;
  const ay = imgA.y - metrics.centerY;
  const transformedA = {
    x: metrics.centerX + scale * (ax * Math.cos(rad) - ay * Math.sin(rad)),
    y: metrics.centerY + scale * (ax * Math.sin(rad) + ay * Math.cos(rad))
  };

  state.transform.scale = Number(scale.toFixed(4));
  state.transform.rotation = Number(rotation.toFixed(2));
  state.transform.offsetX = Number((mapScreenA.x - transformedA.x).toFixed(2));
  state.transform.offsetY = Number((mapScreenA.y - transformedA.y).toFixed(2));
  state.mapImage.calibration = {
    provider: state.tileMap.provider,
    zoom: state.tileMap.zoom,
    mapPoints: state.calibration.mapPoints.map(point => ({ lng: point.lng, lat: point.lat })),
    imagePoints: state.calibration.imagePoints.map(point => ({ imageX: point.imageX, imageY: point.imageY }))
  };
  applyTransform();
  await saveCurrentTransform();
  renderLiveMap();
}

function renderAlignOverlay() {
  const svg = $("#alignOverlay");
  if (!svg) return;
  svg.innerHTML = "";
  const runnerById = new Map(state.runners.map(runner => [runner.id, runner]));
  state.liveStates.forEach(live => {
    const runner = runnerById.get(live.runnerId);
    const name = runner?.name || "";
    if (!["test", "测试点"].includes(name.trim().toLowerCase())) return;
    const point = alignReferencePointFor(live);
    if (!point) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.innerHTML = `
      <circle cx="${point.x}" cy="${point.y}" r="6" fill="#b91c1c" stroke="#ffffff" stroke-width="2"></circle>
      <text x="${point.x + 10}" y="${point.y + 4}" fill="#b91c1c" font-size="12" font-weight="800">${escapeHtml(name)}</text>
    `;
    svg.appendChild(group);
  });
  state.calibration.mapPoints.forEach((point, index) => {
    const screenPoint = referencePointForLngLat(point.lng, point.lat);
    if (!screenPoint) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.innerHTML = `
      <circle cx="${screenPoint.x}" cy="${screenPoint.y}" r="8" fill="none" stroke="#2563eb" stroke-width="2"></circle>
      <text x="${screenPoint.x + 11}" y="${screenPoint.y - 8}" fill="#2563eb" font-size="12" font-weight="800">地图${index + 1}</text>
    `;
    svg.appendChild(group);
  });
  state.calibration.imagePoints.forEach((point, index) => {
    const transformed = transformedImagePoint(point);
    if (!transformed) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.innerHTML = `
      <circle cx="${transformed.x}" cy="${transformed.y}" r="8" fill="none" stroke="#16a34a" stroke-width="2"></circle>
      <text x="${transformed.x + 11}" y="${transformed.y + 14}" fill="#16a34a" font-size="12" font-weight="800">底图${index + 1}</text>
    `;
    svg.appendChild(group);
  });
}

function livePointFor(locationState) {
  const mapRect = liveMapContentRect();
  if (!mapRect) return null;
  if (!state.mapImage) return null;
  const calibrated = calibratedLivePoint(locationState, mapRect);
  if (calibrated) return calibrated;
  const provider = state.mapImage.provider || "osm";
  const anchorCoord = displayLngLat(state.mapImage.anchorLng || 120.123456, state.mapImage.anchorLat || 30.123456, provider);
  const targetCoord = displayLngLat(locationState.latestLng, locationState.latestLat, provider);
  const zoom = state.mapImage.zoom || 16;
  const savedOverlayWidth = state.mapImage.overlayWidth || state.mapImage.imageWidth || mapRect.width;
  const displayRatio = mapRect.width / savedOverlayWidth;
  const scale = (state.mapImage.scale || 1) * displayRatio;
  const centerX = mapRect.left + mapRect.width / 2 + (state.mapImage.offsetX || 0) * displayRatio;
  const centerY = mapRect.top + mapRect.height / 2 + (state.mapImage.offsetY || 0) * displayRatio;
  const anchor = lngLatToWorld(anchorCoord.lng, anchorCoord.lat, zoom);
  const target = lngLatToWorld(targetCoord.lng, targetCoord.lat, zoom);
  const dx = (target.x - anchor.x) * scale;
  const dy = (target.y - anchor.y) * scale;
  const rad = (state.mapImage.rotation || 0) * Math.PI / 180;
  return {
    x: centerX + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: centerY + dx * Math.sin(rad) + dy * Math.cos(rad),
    offMap: false
  };
}

function calibratedLivePoint(locationState, mapRect) {
  const calibration = state.mapImage?.calibration;
  if (!calibration || calibration.mapPoints?.length < 2 || calibration.imagePoints?.length < 2) return null;
  const [mapA, mapB] = calibration.mapPoints;
  const [imageA, imageB] = calibration.imagePoints;
  const provider = calibration.provider || state.mapImage.provider || "osm";
  const zoom = calibration.zoom || state.mapImage.zoom || 16;
  const coordA = displayLngLat(mapA.lng, mapA.lat, provider);
  const coordB = displayLngLat(mapB.lng, mapB.lat, provider);
  const mapWorldA = lngLatToWorld(coordA.lng, coordA.lat, zoom);
  const mapWorldB = lngLatToWorld(coordB.lng, coordB.lat, zoom);
  const targetCoord = displayLngLat(locationState.latestLng, locationState.latestLat, provider);
  const targetWorld = lngLatToWorld(targetCoord.lng, targetCoord.lat, zoom);
  const mapVector = { x: mapWorldB.x - mapWorldA.x, y: mapWorldB.y - mapWorldA.y };
  const mapLen2 = mapVector.x * mapVector.x + mapVector.y * mapVector.y;
  if (mapLen2 < 1) return null;
  const imageVector = { x: imageB.imageX - imageA.imageX, y: imageB.imageY - imageA.imageY };
  const imageLen = Math.hypot(imageVector.x, imageVector.y);
  const mapLen = Math.sqrt(mapLen2);
  if (imageLen < 1) return null;
  const scale = imageLen / mapLen;
  const rotation = Math.atan2(imageVector.y, imageVector.x) - Math.atan2(mapVector.y, mapVector.x);
  const dx = targetWorld.x - mapWorldA.x;
  const dy = targetWorld.y - mapWorldA.y;
  const imageX = imageA.imageX + scale * (dx * Math.cos(rotation) - dy * Math.sin(rotation));
  const imageY = imageA.imageY + scale * (dx * Math.sin(rotation) + dy * Math.cos(rotation));
  const x = mapRect.left + (imageX / Math.max(1, state.mapImage.imageWidth || 1)) * mapRect.width;
  const y = mapRect.top + (imageY / Math.max(1, state.mapImage.imageHeight || 1)) * mapRect.height;
  return { x, y, offMap: false };
}

function clampLivePoint(point) {
  const stage = $("#liveStage").getBoundingClientRect();
  const margin = 22;
  const x = Math.max(margin, Math.min(stage.width - margin, point.x));
  const y = Math.max(margin, Math.min(stage.height - margin, point.y));
  return {
    x,
    y,
    offMap: x !== point.x || y !== point.y
  };
}

function liveMapContentRect() {
  const stage = $("#liveStage").getBoundingClientRect();
  const image = $("#liveMapImage");
  if (!state.mapImage || !image.naturalWidth || !image.naturalHeight) {
    return { left: 0, top: 0, width: stage.width, height: stage.height };
  }
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const stageRatio = stage.width / stage.height;
  let width;
  let height;
  if (stageRatio > imageRatio) {
    height = stage.height;
    width = height * imageRatio;
  } else {
    width = stage.width;
    height = width / imageRatio;
  }
  return {
    left: (stage.width - width) / 2,
    top: (stage.height - height) / 2,
    width,
    height
  };
}

function lngLatToWorld(lng, lat, zoom) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const size = 256 * Math.pow(2, zoom);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size
  };
}

function worldToLngLat(x, y, zoom) {
  const size = 256 * Math.pow(2, zoom);
  const lng = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lng, lat };
}

function trackPointFor(point) {
  if (point?.rejected) return null;
  return livePointFor({
    latestLat: point.displayLat ?? point.lat,
    latestLng: point.displayLng ?? point.lng
  });
}

function recentTrailPoints(points) {
  const cutoff = Date.now() - LIVE_TRAIL_MS;
  return points.filter(point => !point.rejected && Number(point.timestamp || 0) >= cutoff);
}

function renderLiveOverlay() {
  const svg = $("#liveOverlay");
  svg.innerHTML = "";
  const list = $("#liveList");
  list.innerHTML = "";
  const runnerById = new Map(state.runners.map(runner => [runner.id, runner]));
  const visibleIds = visibleRunnerIds();

  if (state.showTracks) {
    Object.entries(state.tracks).forEach(([runnerId, points]) => {
      if (!visibleIds.has(runnerId)) return;
      const pathPoints = recentTrailPoints(points).map(trackPointFor).filter(Boolean);
      if (pathPoints.length < 2) return;
      const color = colorForRunner(runnerId);
      const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      polyline.setAttribute("points", pathPoints.map(point => `${point.x},${point.y}`).join(" "));
      polyline.setAttribute("fill", "none");
      polyline.setAttribute("stroke", color);
      polyline.setAttribute("stroke-width", "3");
      polyline.setAttribute("stroke-linejoin", "round");
      polyline.setAttribute("stroke-linecap", "round");
      polyline.setAttribute("opacity", runnerById.has(runnerId) ? "0.75" : "0.35");
      svg.appendChild(polyline);
    });
  }

  renderPlaybackPaths(svg, runnerById);

  state.liveStates.forEach(live => {
    const runner = runnerById.get(live.runnerId);
    if (!visibleIds.has(live.runnerId)) return;
    const rawPoint = livePointFor(live);
    const point = rawPoint ? clampLivePoint(rawPoint) : null;
    const item = document.createElement("div");
    item.className = `live-item ${live.isOnline ? "" : "offline"}`;
    const rejectedText = live.rejectedCount ? ` · 已过滤跳点 ${live.rejectedCount} 次` : "";
    item.innerHTML = `<strong><span class="status-dot ${live.isOnline ? "" : "offline"}"></span>${escapeHtml(runner?.name || live.runnerId)}</strong><small>${live.isOnline ? "在线" : "离线"} · ${point?.offMap ? "图外 · " : ""}${live.staleSeconds || 0} 秒前 · 精度 ${live.accuracy || 0}m${rejectedText} · ${new Date(live.lastSeenAt).toLocaleTimeString()}</small>`;
    list.appendChild(item);
    if (!point) return;

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const color = point.offMap ? "#b91c1c" : live.isOnline ? colorForRunner(live.runnerId) : "#b91c1c";
    group.innerHTML = `
      <circle cx="${point.x}" cy="${point.y}" r="${point.offMap ? 6 : 5}" fill="${color}" stroke="#ffffff" stroke-width="2"></circle>
      <text x="${point.x + 9}" y="${point.y + 4}" fill="${point.offMap ? "#b91c1c" : "#18201a"}" font-size="12" font-weight="700">${escapeHtml(runner?.name || live.runnerId)}${point.offMap ? "（图外）" : ""}</text>
    `;
    svg.appendChild(group);
  });

  renderPlaybackMarker(svg, runnerById);
  $("#liveEmpty").style.display = state.liveStates.length && state.mapImage ? "none" : "grid";
}

function renderPlaybackPaths(svg, runnerById) {
  if (!state.playback.runnerId) return;
  playbackSelectedRunnerIds().forEach(runnerId => {
    if (!runnerById.has(runnerId)) return;
    const points = playbackValidPoints(runnerId).slice(0, state.playback.index + 1);
    const pathPoints = points.map(trackPointFor).filter(Boolean);
    if (pathPoints.length < 2) return;
    const color = colorForRunner(runnerId);
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", pathPoints.map(point => `${point.x},${point.y}`).join(" "));
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", color);
    polyline.setAttribute("stroke-width", "3");
    polyline.setAttribute("stroke-linejoin", "round");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("opacity", "0.9");
    svg.appendChild(polyline);
  });
}

function renderPlaybackMarker(svg, runnerById) {
  const selectedIds = playbackSelectedRunnerIds();
  selectedIds.forEach(runnerId => {
    const points = playbackValidPoints(runnerId);
    if (!points.length) return;
    const index = Math.min(state.playback.index, points.length - 1);
    const point = trackPointFor(points[index]);
    if (!point) return;
    const runner = runnerById.get(runnerId);
    const color = colorForRunner(runnerId);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.innerHTML = `
      <circle cx="${point.x}" cy="${point.y}" r="5" fill="${color}" stroke="#ffffff" stroke-width="2"></circle>
      <text x="${point.x + 9}" y="${point.y + 4}" fill="#18201a" font-size="12" font-weight="700">${escapeHtml(runner?.name || runnerId)}</text>
    `;
    svg.appendChild(group);
  });
}

function renderPlaybackOptions() {
  const select = $("#playbackRunner");
  const checks = $("#playbackRunnerChecks");
  if (!select) return;
  const current = state.playback.runnerId;
  select.innerHTML = `<option value="">选择参赛者</option>`;
  if (checks) checks.innerHTML = "";
  state.runners.forEach(runner => {
    const option = document.createElement("option");
    option.value = runner.id;
    option.textContent = runner.name;
    select.appendChild(option);

    const checked = state.playback.selectedRunnerIds.size
      ? state.playback.selectedRunnerIds.has(runner.id)
      : runner.id === current;
    const label = document.createElement("label");
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(runner.id)}" ${checked ? "checked" : ""}>
      <span class="runner-swatch" style="background:${colorForRunner(runner.id)}"></span>
      <span>${escapeHtml(runner.name)}</span>
    `;
    label.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.playback.selectedRunnerIds.add(runner.id);
      } else {
        state.playback.selectedRunnerIds.delete(runner.id);
      }
      renderPlaybackControls();
      renderLiveOverlay();
    });
    checks?.appendChild(label);
  });
  if (current && state.runners.some(runner => runner.id === current)) {
    select.value = current;
  }
  if (!state.playback.runnerId && state.runners[0]) {
    state.playback.runnerId = state.runners[0].id;
    select.value = state.playback.runnerId;
  }
  if (!state.playback.selectedRunnerIds.size && state.playback.runnerId) {
    state.playback.selectedRunnerIds.add(state.playback.runnerId);
  }
  renderPlaybackControls();
}

function playbackValidPoints(runnerId) {
  return (state.tracks[runnerId] || []).filter(point => !point.rejected);
}

function playbackSelectedRunnerIds() {
  const selected = Array.from(state.playback.selectedRunnerIds).filter(id => state.runners.some(runner => runner.id === id));
  return selected.length ? selected : (state.playback.runnerId ? [state.playback.runnerId] : []);
}

function renderPlaybackControls() {
  const range = $("#playbackRange");
  const label = $("#playbackTime");
  if (!range || !label) return;
  const points = playbackValidPoints(state.playback.runnerId);
  range.max = String(Math.max(0, points.length - 1));
  range.value = String(Math.min(state.playback.index, Math.max(0, points.length - 1)));
  if (!points.length) {
    label.textContent = "暂无轨迹";
    return;
  }
  const point = points[Math.min(state.playback.index, points.length - 1)];
  label.textContent = `${state.playback.index + 1}/${points.length} · ${new Date(point.timestamp).toLocaleString()}`;
}

async function refreshTracks() {
  if (!state.selectedEventId) return;
  const tracks = {};
  await Promise.all(state.runners.map(async runner => {
    const data = await api(`/api/events/${state.selectedEventId}/runners/${runner.id}/track`);
    tracks[runner.id] = data.track;
  }));
  state.tracks = tracks;
  renderPlaybackOptions();
  renderLiveOverlay();
}

async function refreshLiveStates() {
  if (!state.selectedEventId) return;
  const data = await api(`/api/events/${state.selectedEventId}/live`);
  state.liveStates = data.liveStates;
  renderAlignOverlay();
  renderLiveOverlay();
}

function stopPlayback() {
  state.playback.playing = false;
  $("#playPause").textContent = "播放";
  if (state.playback.timer) clearInterval(state.playback.timer);
  state.playback.timer = null;
}

function startPlayback() {
  const points = playbackValidPoints(state.playback.runnerId);
  if (points.length < 2) return;
  state.playback.playing = true;
  $("#playPause").textContent = "暂停";
  state.playback.timer = setInterval(() => {
    const current = state.playback.index + 1;
    if (current >= points.length) {
      stopPlayback();
      return;
    }
    state.playback.index = current;
    renderPlaybackControls();
    renderLiveOverlay();
  }, Math.max(80, 700 / state.playback.speed));
}

async function refreshEvents() {
  const data = await api("/api/events");
  state.events = data.events;
  if (!state.events.some(event => event.id === state.selectedEventId)) {
    state.selectedEventId = state.events[0]?.id || null;
  }
  renderEvents();
  if (state.selectedEventId) {
    await selectEvent(state.selectedEventId, false);
  } else {
    clearSelection();
  }
}

function clearSelection() {
  state.mapImage = null;
  state.runners = [];
  state.liveStates = [];
  state.tracks = {};
  if (state.liveRefreshTimer) clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer = null;
  renderRunners();
  renderLiveMap();
  renderApiExample();
}

async function selectEvent(eventId, rerender = true) {
  state.selectedEventId = eventId;
  if (rerender) renderEvents();
  const [mapData, runnersData, liveData] = await Promise.all([
    api(`/api/events/${eventId}/map-image`),
    api(`/api/events/${eventId}/runners`),
    api(`/api/events/${eventId}/live`)
  ]);
  state.runners = runnersData.runners;
  state.liveStates = liveData.liveStates;
  loadMapImage(mapData.mapImage);
  renderRunners();
  renderLiveMap();
  renderApiExample();
  connectWs();
  if (state.liveRefreshTimer) clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer = setInterval(refreshLiveStates, 5000);
  refreshTracks();
}

function connectWs() {
  if (state.ws) state.ws.close();
  if (!state.selectedEventId) return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${scheme}://${location.host}/ws/events/${state.selectedEventId}/live`);
  state.ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot" || message.type === "location") {
      state.liveStates = message.liveStates || state.liveStates;
      if (message.point) {
        state.tracks[message.point.runnerId] = state.tracks[message.point.runnerId] || [];
        state.tracks[message.point.runnerId].push(message.point);
        renderPlaybackControls();
        if (!state.runners.some(runner => runner.id === message.point.runnerId)) {
          refreshRunners();
        }
      }
      renderAlignOverlay();
      renderLiveOverlay();
    }
    if (message.type === "map-transform") {
      loadMapImage(message.mapImage);
    }
    if (message.type === "runner-created") {
      if (!state.runners.some(runner => runner.id === message.runner.id)) {
        state.runners.push(message.runner);
      }
      renderRunners();
      renderLiveOverlay();
    }
    if (message.type === "runner-updated") {
      if (state.runners.some(runner => runner.id === message.runner.id)) {
        state.runners = state.runners.map(runner => runner.id === message.runner.id ? message.runner : runner);
      } else {
        state.runners.push(message.runner);
      }
      renderRunners();
      renderLiveOverlay();
    }
    if (message.type === "runner-deleted") {
      state.runners = state.runners.filter(runner => runner.id !== message.runnerId);
      state.liveStates = state.liveStates.filter(live => live.runnerId !== message.runnerId);
      delete state.tracks[message.runnerId];
      renderRunners();
      renderAlignOverlay();
      renderLiveOverlay();
    }
    if (message.type === "event-updated") {
      state.events = state.events.map(event => event.id === message.event.id ? message.event : event);
      renderEvents();
      renderApiExample();
    }
    if (message.type === "event-deleted") {
      refreshEvents();
    }
  };
}

async function refreshRunners() {
  if (!state.selectedEventId) return;
  const data = await api(`/api/events/${state.selectedEventId}/runners`);
  state.runners = data.runners;
  renderRunners();
  renderPlaybackOptions();
  renderLiveOverlay();
}

function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const image = new Image();
    reader.onload = () => {
      image.onload = () => {
        const base64 = reader.result.split(",")[1];
        resolve({
          dataBase64: base64,
          mimeType: file.type,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight
        });
      };
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function stepRangeInput(inputId, direction) {
  const input = $(`#${inputId}`);
  if (!input) return;
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step || 1);
  const current = Number(input.value || 0);
  const next = Math.max(min, Math.min(max, current + direction * step));
  input.value = String(Number(next.toFixed(4)));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyLiveViewTransform() {
  const viewport = $("#liveViewport");
  if (!viewport) return;
  viewport.style.transform = `translate(${state.liveView.x}px, ${state.liveView.y}px) scale(${state.liveView.scale})`;
  const label = $("#liveZoomLabel");
  if (label) label.textContent = `${Math.round(state.liveView.scale * 100)}%`;
}

function setLiveZoom(nextScale, originX, originY) {
  const oldScale = state.liveView.scale;
  const scale = Math.max(0.5, Math.min(5, nextScale));
  const stage = $("#liveStage").getBoundingClientRect();
  const x = originX ?? stage.width / 2;
  const y = originY ?? stage.height / 2;
  const worldX = (x - state.liveView.x) / oldScale;
  const worldY = (y - state.liveView.y) / oldScale;
  state.liveView.scale = scale;
  state.liveView.x = x - worldX * scale;
  state.liveView.y = y - worldY * scale;
  applyLiveViewTransform();
}

function resetLiveView() {
  state.liveView.scale = 1;
  state.liveView.x = 0;
  state.liveView.y = 0;
  applyLiveViewTransform();
}

function setCalibrationMode(mode) {
  state.calibrationMode = mode;
  $("#alignStage")?.classList.toggle("capture-map", mode === "map");
  $("#alignStage")?.classList.toggle("capture-image", mode === "image");
}

async function addTestPointAtMapCenter() {
  if (!state.selectedEventId) return alert("请先创建或选择赛事");
  if (!state.mapImage) return alert("请先上传并保存对齐底图");

  let runner = state.runners.find(item => item.name === "测试点");
  if (!runner) {
    const data = await api(`/api/events/${state.selectedEventId}/runners`, {
      method: "POST",
      body: JSON.stringify({ name: "测试点" })
    });
    runner = data.runner;
    state.runners.push(runner);
    renderRunners();
  }

  const sourceCoord = sourceLngLatFromDisplay(state.tileMap.centerLng, state.tileMap.centerLat, state.tileMap.provider);
  await api("/api/location/report", {
    method: "POST",
    body: JSON.stringify({
      eventId: state.selectedEventId,
      runnerId: runner.id,
      uploadToken: runner.uploadToken,
      lat: sourceCoord.lat,
      lng: sourceCoord.lng,
      coordSystem: "WGS84",
      accuracy: 1,
      speed: 0,
      heading: 0,
      timestamp: Date.now()
    })
  });
  await refreshLiveStates();
  await refreshTracks();
  document.querySelector('[data-tab="live"]').click();
}

function bindEvents() {
  $("#eventForm").addEventListener("submit", async event => {
    event.preventDefault();
    const formEl = event.currentTarget;
    try {
      const form = new FormData(formEl);
      const data = await api("/api/events", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description")
        })
      });
      formEl.reset();
      state.events = [data.event];
      await selectEvent(data.event.id);
    } catch (error) {
      console.error(error);
      alert(`创建赛事失败：${error.message || "请检查管理员登录和网络"}`);
    }
  });

  $("#runnerForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.selectedEventId) return alert("请先选择赛事");
    const formEl = event.currentTarget;
    try {
      const form = new FormData(formEl);
      await api(`/api/events/${state.selectedEventId}/runners`, {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name")
        })
      });
      formEl.reset();
      await selectEvent(state.selectedEventId);
    } catch (error) {
      console.error(error);
      alert(`添加参赛者失败：${error.message || "请检查管理员登录和网络"}`);
    }
  });

  $("#showTracks").addEventListener("change", event => {
    state.showTracks = event.target.checked;
    renderLiveOverlay();
  });

  $("#refreshTracks").addEventListener("click", refreshTracks);

  $("#playbackRunner").addEventListener("change", event => {
    stopPlayback();
    state.playback.runnerId = event.target.value;
    if (state.playback.runnerId) state.playback.selectedRunnerIds.add(state.playback.runnerId);
    state.playback.index = 0;
    renderPlaybackOptions();
    renderPlaybackControls();
    renderLiveOverlay();
  });

  $("#playbackSpeed").addEventListener("change", event => {
    state.playback.speed = Number(event.target.value || 1);
    if (state.playback.playing) {
      stopPlayback();
      startPlayback();
    }
  });

  $("#playbackRange").addEventListener("input", event => {
    stopPlayback();
    state.playback.index = Number(event.target.value);
    renderPlaybackControls();
    renderLiveOverlay();
  });

  $("#playPause").addEventListener("click", () => {
    if (state.playback.playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  $("#playReset").addEventListener("click", () => {
    stopPlayback();
    state.playback.index = 0;
    renderPlaybackControls();
    renderLiveOverlay();
  });

  $("#simulateMove").addEventListener("click", async () => {
    if (!state.selectedEventId) return alert("请先选择赛事");
    if (!state.runners.length) return alert("请先添加参赛者");
    const runner = state.runners[0];
    const baseLat = state.mapImage?.anchorLat || 30.123456;
    const baseLng = state.mapImage?.anchorLng || 120.123456;
    const index = (state.tracks[runner.id]?.length || 0) + 1;
    await api("/api/location/report", {
      method: "POST",
      body: JSON.stringify({
        eventId: state.selectedEventId,
        runnerId: runner.id,
        uploadToken: runner.uploadToken,
        lat: baseLat + index * 0.00003,
        lng: baseLng + index * 0.00004,
        coordSystem: "WGS84",
        accuracy: 8 + (index % 4),
        speed: 2,
        heading: 60,
        timestamp: Date.now()
      })
    });
  });

  $("#liveZoomIn").addEventListener("click", () => setLiveZoom(state.liveView.scale * 1.2));
  $("#liveZoomOut").addEventListener("click", () => setLiveZoom(state.liveView.scale / 1.2));
  $("#liveZoomReset").addEventListener("click", resetLiveView);

  $("#liveStage").addEventListener("wheel", event => {
    event.preventDefault();
    const rect = $("#liveStage").getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setLiveZoom(state.liveView.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  $("#liveStage").addEventListener("pointerdown", event => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    $("#liveStage").setPointerCapture(event.pointerId);
    state.liveView.drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: state.liveView.x,
      startY: state.liveView.y
    };
  });

  $("#liveStage").addEventListener("pointermove", event => {
    const drag = state.liveView.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.liveView.x = drag.startX + event.clientX - drag.x;
    state.liveView.y = drag.startY + event.clientY - drag.y;
    applyLiveViewTransform();
  });

  $("#liveStage").addEventListener("pointerup", event => {
    if (state.liveView.drag?.pointerId === event.pointerId) state.liveView.drag = null;
  });

  $("#mapFile").addEventListener("change", async event => {
    if (!state.selectedEventId) return alert("请先选择赛事");
    const file = event.target.files[0];
    if (!file) return;
    const payload = await fileToPayload(file);
    const data = await api(`/api/events/${state.selectedEventId}/map-image`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    loadMapImage(data.mapImage);
    renderLiveMap();
  });

  $("#scaleInput").addEventListener("input", event => {
    state.transform.scale = Number(event.target.value);
    applyTransform();
  });
  $("#rotationInput").addEventListener("input", event => {
    state.transform.rotation = Number(event.target.value);
    applyTransform();
  });
  $("#opacityInput").addEventListener("input", event => {
    state.transform.opacity = Number(event.target.value);
    applyTransform();
  });
  document.querySelectorAll("[data-step-target]").forEach(button => {
    button.addEventListener("click", () => {
      stepRangeInput(button.dataset.stepTarget, Number(button.dataset.stepDir || 1));
    });
  });
  $("#showReferenceMap").addEventListener("change", event => {
    setReferenceMapVisible(event.target.checked);
  });

  $("#saveTransform").addEventListener("click", async () => {
    if (!state.selectedEventId || !state.mapImage) return alert("请先上传底图");
    await saveCurrentTransform();
  });

  $("#resetTransform").addEventListener("click", () => {
    state.transform = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 0.65 };
    applyTransform();
  });

  $("#goCenter").addEventListener("click", () => {
    const lng = Number($("#centerLng").value);
    const lat = Number($("#centerLat").value);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return alert("请输入有效的经纬度");
    setMapCenter(lng, lat);
  });

  $("#mapProvider").addEventListener("change", event => {
    state.tileMap.provider = event.target.value;
    renderTileMap();
    updateMapReadout();
  });

  $("#addTestPoint").addEventListener("click", addTestPointAtMapCenter);
  $("#captureMapPoints").addEventListener("click", startMapPointCapture);
  $("#captureImagePoints").addEventListener("click", startImagePointCapture);
  $("#applyTwoPointCalibration").addEventListener("click", applyTwoPointCalibration);
  $("#clearControlPoints").addEventListener("click", () => {
    setCalibrationMode(null);
    state.calibration = { mapPoints: [], imagePoints: [] };
    renderAlignOverlay();
  });

  $("#tileMap").addEventListener("pointerdown", event => {
    if (state.calibrationMode === "map") {
      addMapCalibrationPoint(event);
      return;
    }
    state.tileMap.drag = {
      x: event.clientX,
      y: event.clientY,
      center: lngLatToWorld(state.tileMap.centerLng, state.tileMap.centerLat, state.tileMap.zoom)
    };
    $("#tileMap").classList.add("dragging");
    $("#tileMap").setPointerCapture(event.pointerId);
  });

  $("#tileMap").addEventListener("pointermove", event => {
    if (!state.tileMap.drag) return;
    const dx = event.clientX - state.tileMap.drag.x;
    const dy = event.clientY - state.tileMap.drag.y;
    const next = worldToLngLat(
      state.tileMap.drag.center.x - dx,
      state.tileMap.drag.center.y - dy,
      state.tileMap.zoom
    );
    state.tileMap.centerLng = next.lng;
    state.tileMap.centerLat = next.lat;
    renderTileMap();
    updateMapReadout();
  });

  $("#tileMap").addEventListener("pointerup", event => {
    state.tileMap.drag = null;
    $("#tileMap").classList.remove("dragging");
    $("#tileMap").releasePointerCapture(event.pointerId);
  });

  $("#tileMap").addEventListener("wheel", event => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -1 : 1;
    state.tileMap.zoom = Math.max(3, Math.min(19, state.tileMap.zoom + delta));
    renderTileMap();
    updateMapReadout();
  }, { passive: false });

  $("#overlayImage").addEventListener("pointerdown", event => {
    if (state.calibrationMode === "image") {
      addImageCalibrationPoint(event);
      return;
    }
    state.drag = {
      x: event.clientX,
      y: event.clientY,
      offsetX: state.transform.offsetX,
      offsetY: state.transform.offsetY
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  });

  $("#overlayImage").addEventListener("pointermove", event => {
    if (!state.drag) return;
    state.transform.offsetX = state.drag.offsetX + event.clientX - state.drag.x;
    state.transform.offsetY = state.drag.offsetY + event.clientY - state.drag.y;
    applyTransform();
  });

  $("#overlayImage").addEventListener("pointerup", () => {
    state.drag = null;
  });

  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab) showTab(tab.dataset.tab);
    });
  });

  $("#adminLogin").addEventListener("click", loginAdmin);
  $("#adminLogout").addEventListener("click", logoutAdmin);

  $("#copyJoinLink").addEventListener("click", async () => {
    const value = $("#joinLink").value;
    if (!value) return alert("请先创建或选择赛事");
    await navigator.clipboard.writeText(value);
  });

  $("#serverOrigin").addEventListener("input", renderApiExample);
  $("#useCurrentOrigin").addEventListener("click", () => {
    $("#serverOrigin").value = location.origin;
    localStorage.setItem("appServerUrl", location.origin);
    renderApiExample();
  });

  $("#searchPlace").addEventListener("click", searchPlace);
  $("#placeKeyword").addEventListener("keydown", event => {
    if (event.key === "Enter") searchPlace();
  });

  window.addEventListener("resize", renderLiveOverlay);
  window.addEventListener("resize", renderAlignOverlay);
  window.addEventListener("resize", renderTileMap);
}

async function boot() {
  bindEvents();
  $("#serverOrigin").value = defaultServerOrigin();
  if (state.adminPassword) {
    try {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: state.adminPassword })
      });
      state.isAdmin = true;
    } catch {
      state.adminPassword = "";
      localStorage.removeItem("adminPassword");
    }
  }
  applyAdminMode();
  renderTileMap();
  updateMapReadout();
  try {
    await api("/api/health");
    setStatus("服务正常", true);
    await refreshEvents();
  } catch (error) {
    setStatus("服务异常");
    console.error(error);
  }
  renderApiExample();
}

boot();
