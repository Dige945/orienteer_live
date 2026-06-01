# Cloudflare 部署方案

## 目标

把当前“定向实时定位”系统从本机 `npm start + cloudflared` 改造成 Cloudflare 托管架构。

改造后希望达到：

- 不需要一直开自己的电脑。
- 不需要临时内网穿透。
- 网页有固定公网地址。
- 游客打开网页只能看实时大屏。
- 管理员登录后才能管理赛事、参赛者、底图和手机接入。
- 手机 App 扫码后直接上传到 Cloudflare。
- 实时大屏可以看到定位点和最近 20 秒拖痕。

## 当前本机架构

当前项目主要由这些部分组成：

```text
public/
  index.html
  app.js
  styles.css

server.js
  静态文件服务
  REST API
  WebSocket
  本地 JSON 数据存储
  本地图片上传

data/store.json
  赛事、参赛者、轨迹、实时状态

public/uploads/maps/
  定向底图图片
```

当前运行方式：

```bat
npm start
cloudflared tunnel --url http://localhost:3000
```

问题：

- 电脑关机后网站不可用。
- 临时 cloudflared 地址会变化。
- 网络不稳定时 tunnel 容易断。
- 本地文件系统不适合公网长期服务。

## 目标 Cloudflare 架构

推荐拆成四层：

```text
Cloudflare Pages
  托管前端网页

Cloudflare Workers
  提供 REST API
  处理手机加入、定位上传、管理员登录等

Cloudflare Durable Objects
  管理每个赛事的实时状态
  处理 WebSocket 连接和广播

Cloudflare D1 或 Durable Object Storage
  存储赛事、参赛者、轨迹、校准参数、当前底图
```

建议第一版优先使用：

```text
Pages + Worker + Durable Objects
```

D1 和 R2 可以后续再引入。第一版可以把赛事状态、轨迹和当前这一张底图先放 Durable Object Storage，减少数据库和对象存储迁移复杂度。

## 数据划分

### 赛事 Event

字段：

```json
{
  "id": "event-xxx",
  "code": "ABC123",
  "name": "赛事名称",
  "description": "",
  "status": "draft",
  "createdAt": "",
  "updatedAt": ""
}
```

第一版仍然保持单赛事模式：

- 新建赛事会替换当前赛事。
- 旧参赛者、旧轨迹、旧底图记录清空。

### 参赛者 Runner

字段：

```json
{
  "id": "runner-xxx",
  "eventId": "event-xxx",
  "name": "张三",
  "deviceId": "手机设备ID",
  "uploadToken": "token-xxx",
  "status": "active",
  "createdAt": "",
  "updatedAt": ""
}
```

手机只需要传姓名。

### 定向底图 MapImage

字段：

```json
{
  "id": "map-xxx",
  "eventId": "event-xxx",
  "imageUrl": "https://...",
  "imageKey": "maps/event-xxx.png",
  "imageWidth": 1000,
  "imageHeight": 800,
  "anchorLng": 114.0,
  "anchorLat": 30.0,
  "offsetX": 0,
  "offsetY": 0,
  "scale": 1,
  "rotation": 0,
  "opacity": 0.65,
  "zoom": 16,
  "provider": "osm",
  "overlayWidth": 900,
  "calibration": {
    "provider": "osm",
    "zoom": 16,
    "mapPoints": [
      { "lng": 114.0, "lat": 30.0 },
      { "lng": 114.001, "lat": 30.001 }
    ],
    "imagePoints": [
      { "imageX": 100, "imageY": 200 },
      { "imageX": 500, "imageY": 600 }
    ]
  },
  "createdAt": "",
  "updatedAt": ""
}
```

第一版底图用 `data:` URL 存到 Durable Object Storage。因为当前是单赛事模式，并且每次只保留一张底图，这个方案成本最低，也不需要开通 R2。

建议底图上传前压缩到 1-2MB 以内。

### 定位点 LocationPoint

字段：

```json
{
  "id": "loc-xxx",
  "eventId": "event-xxx",
  "runnerId": "runner-xxx",
  "lat": 30.0,
  "lng": 114.0,
  "coordSystem": "WGS84",
  "accuracy": 8,
  "speed": 2,
  "heading": 90,
  "timestamp": 1710000000000,
  "createdAt": ""
}
```

第一版建议：

- 实时状态放 Durable Object 内存 + 存储。
- 轨迹可以保留最近一段时间，避免 Worker 存储过大。
- 如果需要长期历史轨迹，再迁到 D1。

## API 设计

保留当前 API 路径，减少手机端改动。

### 公开接口

```text
GET  /api/health
GET  /api/diagnostics
GET  /api/events
GET  /api/events/:eventId
GET  /api/mobile/events/:eventIdOrCode
POST /api/mobile/join
POST /api/location/report
POST /api/location/batch-report
GET  /api/events/:eventId/live
GET  /api/events/:eventId/runners
GET  /api/events/:eventId/runners/:runnerId/track
GET  /api/events/:eventId/map-image
WS   /ws/events/:eventId/live
```

### 管理员接口

需要 `x-admin-password` 或后续改成 session token。

```text
POST   /api/admin/login
POST   /api/events
PUT    /api/events/:eventId
DELETE /api/events/:eventId
POST   /api/events/:eventId/runners
PUT    /api/events/:eventId/runners/:runnerId
DELETE /api/events/:eventId/runners/:runnerId
POST   /api/events/:eventId/map-image
PUT    /api/events/:eventId/map-transform
```

第一版可以继续用管理员密码。

Cloudflare Worker 环境变量：

```text
ADMIN_PASSWORD=你的管理员密码
```

后续可升级：

- 管理员登录返回短期 token。
- token 存 Cookie 或 localStorage。
- Worker 校验 token。

## WebSocket 方案

Cloudflare Worker 接收：

```text
/ws/events/:eventId/live
```

然后把请求转发给对应赛事的 Durable Object。

Durable Object 负责：

- 保存当前赛事 liveStates。
- 管理 WebSocket clients。
- 收到定位更新时广播给所有大屏。
- 处理 snapshot。

结构：

```text
EventRoom Durable Object
  eventId
  liveStates
  websocket clients
  runners
  mapImage
  recent tracks
```

定位上传流程：

```text
手机 POST /api/location/report
Worker 校验 runner token
Worker 找到 EventRoom
EventRoom 更新 liveStates
EventRoom 广播 WebSocket
```

## 图片上传方案

当前本机：

```text
public/uploads/maps/*.png
```

Cloudflare 第一版改为 Durable Object Storage：

```text
mapImage.imageUrl = data:image/png;base64,...
```

上传接口：

```text
POST /api/events/:eventId/map-image
```

请求仍然用 base64，方便前端少改。

后续优化：

- 如果要保存多场赛事底图，改成 R2。
- 改成 multipart upload。
- 或者 Worker 生成 R2 presigned upload URL。

第一版用 base64 可以接受，但要注意 Worker 请求体大小限制。底图过大时要压缩，或者后续改 R2 直传。

## 前端部署方案

前端第一版直接随 Worker Static Assets 一起部署，不单独使用 Cloudflare Pages。

建议目录：

```text
public/
  index.html
  app.js
  styles.css
```

如果 Worker 和 Pages 同域：

```text
https://你的域名/
https://你的域名/api/...
https://你的域名/ws/...
```

前端 API 可以继续使用相对路径：

```js
fetch("/api/health")
new WebSocket("wss://你的域名/ws/events/...")
```

这样手机扫码也更简单。

注意：Cloudflare Pages 的 `_redirects` 不能代理到外部域名，所以不推荐用 `pages.dev` 再代理到 `workers.dev`。当前最简单稳定的方案是一个 Worker 同时托管静态网页和 API。

## 手机端影响

Android App 改动很小。

当前扫码链接：

```text
orienteer://join?code=ABC123&server=https://xxx.trycloudflare.com
```

Cloudflare 部署后：

```text
orienteer://join?code=ABC123&server=https://你的域名
```

手机端仍然：

- 扫码
- 获取赛事名称
- 传姓名加入
- 每 2 秒上传定位
- 息屏继续上传

## 推荐迁移步骤

### 第 1 步：整理本地代码结构

新增 Cloudflare 目录：

```text
cloudflare/
  worker/
    src/
      index.js
      event-room.js
    wrangler.toml
```

保留本地 `server.js`，迁移期间两套并存。

当前进度：已完成。

### 第 2 步：抽离共享数据逻辑

把这些逻辑从 `server.js` 中抽出来：

- id 生成
- eventCode 生成
- normalizeLocation
- liveSnapshot
- token 校验

建议：

```text
shared/
  domain.js
```

本地 Node 和 Worker 共用，减少两边行为不一致。

### 第 3 步：实现 Worker 基础 API

先实现：

```text
GET /api/health
GET /api/diagnostics
GET /api/events
POST /api/admin/login
```

确保 Pages 能访问 Worker。

当前进度：已完成基础版本。

### 第 4 步：实现赛事和参赛者管理

实现：

```text
POST /api/events
PUT /api/events/:eventId
DELETE /api/events/:eventId
GET /api/events/:eventId/runners
POST /api/events/:eventId/runners
PUT /api/events/:eventId/runners/:runnerId
DELETE /api/events/:eventId/runners/:runnerId
```

当前进度：已完成 Worker 版本。

### 第 5 步：实现手机加入和定位上传

实现：

```text
GET  /api/mobile/events/:eventIdOrCode
POST /api/mobile/join
POST /api/location/report
POST /api/location/batch-report
```

当前进度：已完成 Worker 版本。

### 第 6 步：实现 Durable Object 实时大屏

实现：

```text
GET /api/events/:eventId/live
WS  /ws/events/:eventId/live
```

定位上传后广播。

当前进度：已完成基础 WebSocket 广播。

### 第 7 步：实现底图上传

实现：

```text
POST /api/events/:eventId/map-image
GET  /api/events/:eventId/map-image
PUT  /api/events/:eventId/map-transform
```

默认不使用 R2，图片以 `data:` URL 存入 Durable Object Storage。

当前进度：已完成 `data:` URL 存储方案；代码仍保留 R2 兼容逻辑，后续加回 R2 绑定即可启用。

### 第 8 步：部署 Pages + Worker

使用 Wrangler：

```bat
npm install -g wrangler
wrangler login
```

部署 Worker：

```bat
npm run cf:worker:deploy
```

当前配置已使用 Worker Static Assets，部署 Worker 时会同时上传 `public/` 网页文件，所以不需要单独部署 Pages。

当前进度：已配置 `cloudflare/worker/wrangler.toml` 的 `[assets]`，还需要实际 Cloudflare 账号环境验证。

### 第 9 步：部署后验证

只读验证，不会创建或删除赛事：

```bat
set CF_BASE=https://你的域名
npm run cf:smoke
```

完整写入验证会创建测试赛事、加入测试参赛者、上传测试定位、上传测试底图、再删除测试赛事。注意：当前系统是单赛事模式，所以这个命令会覆盖并清空当前赛事，只能在测试环境或确认没有正式赛事时运行。

```bat
set CF_BASE=https://你的域名
set ADMIN_PASSWORD=你的管理员密码
npm run cf:smoke:write
```

当前进度：已新增 `scripts/cloudflare-smoke.js` 和 npm 命令。

## 第一版限制

第一版可以先接受这些限制：

- 单赛事模式。
- 管理员密码简单校验。
- 底图 base64 上传。
- 轨迹只保留最近一段时间。
- 不做复杂用户系统。

后续再增强：

- 多赛事列表和归档。
- D1 长期轨迹存储。
- 管理员账号系统。
- 自定义域名。
- R2 图片直传。
- 自动压缩底图。

## 成本估计

低频小比赛/训练场景，Cloudflare 成本通常很低。

主要消耗：

- Workers 请求数
- Durable Objects 请求和存储
- Durable Objects 存储
- Pages 基本静态托管

如果参赛者数量几十人，每 2 秒上传一次：

```text
30 人 * 30 次/分钟 = 900 请求/分钟
```

正式比赛时要关注 Workers 免费额度和 Durable Objects 计费。

如果要长期稳定生产使用，建议使用 Cloudflare 付费计划，并使用命名 Tunnel/自定义域名/正式 Worker 部署，而不是 quick tunnel。

## 开发优先级

建议先做：

1. Worker + Durable Object 骨架。
2. 管理员登录和单赛事管理。
3. 手机加入和定位上传。
4. WebSocket 实时大屏。
5. 底图上传。

完成后再考虑：

1. D1 长期轨迹。
2. 多赛事管理。
3. 管理员账号体系。
4. 自动部署。
