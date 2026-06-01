# Orienteer Live

定向越野实时定位 MVP。公共地图只作为校准参照层使用：先把定向图图片覆盖到公共地图上完成对齐，保存对齐参数后，实时大屏以定向图为主视图，手机 GPS 位置会映射到定向图上显示。

## 运行

在 Windows 上建议用 Command Prompt 运行 npm：

```bat
npm start
```

也可以直接运行：

```bat
start-local.cmd
```

打开：

```text
http://localhost:3000
```

手机 App 调试时，手机和电脑必须在同一局域网。App 里的服务器地址不要填 `localhost`，要填服务启动日志里的 `LAN access` 地址，例如：

```text
http://192.168.1.10:3000
```

如果要让不在同一 Wi-Fi 的手机连接，使用内网穿透：

```bat
start-local.cmd
start-tunnel.cmd
```

`start-tunnel.cmd` 默认使用 `--protocol http2`，因为在部分网络里 Cloudflare Tunnel 的默认 QUIC/UDP 连接会不稳定。脚本也兼容 `winget` 安装后 `cloudflared` 没有进入 PATH 的情况。

把 `start-tunnel.cmd` 输出的 `https://*.trycloudflare.com` 地址填到 Android App 的服务器地址。
网页 `App access` 里的 `App server URL` 也要填这个 tunnel 地址，这样生成的二维码/deep link 才会让手机连到公网 tunnel，而不是连 `localhost`。
这个地址会保存在浏览器里；如果 tunnel 地址变了，记得更新 `App server URL`。
可以先打开：

```text
https://xxxx.trycloudflare.com/api/diagnostics
```

如果返回 `ok: true`，说明公网 tunnel 已经能访问到后端。
如果提示找不到 `cloudflared`，先运行：

```bat
winget install Cloudflare.cloudflared
```

更多实机部署方案见 [DEPLOY.md](./DEPLOY.md)。

## 检查

在 Command Prompt 中运行：

```bat
npm run check
npm run smoke
```

`smoke` 会启动临时端口服务，验证创建赛事、赛事码加入、底图 transform 保存、定位上报、实时状态和轨迹查询。

## 当前能力

- 创建赛事
- 每个赛事自动生成短赛事码，便于手机端加入
- 网页端提供 `orienteer://join` 手机加入链接，可转换成二维码用于现场扫码
- 网页端可一键复制手机加入链接
- 网页端会显示加入二维码，手机安装 App 后扫码可自动填入服务器地址和赛事码
- 上传 PNG/JPG/WebP 定向底图
- 在公共地图容器上覆盖定向图
- 手动拖动、缩放、旋转、调透明度
- 保存并恢复底图对齐参数
- 添加参赛者
- App/脚本通过 API 上报定位
- 实时大屏通过 WebSocket 显示人员位置
- 查询单个参赛者轨迹
- Android App 使用前台服务 + Android 系统 LocationManager 支持息屏定位
- Android App 上报失败时写入本地队列，恢复后批量补传
- 实时大屏支持显示/隐藏轨迹
- 实时大屏支持选择参赛者进行轨迹回放
- 实时大屏会根据最后上报时间动态显示在线/离线
- 实时大屏提供模拟移动按钮，便于无真机时验证定位链路

公共地图只作为校准参照层使用，当前使用 OpenStreetMap 瓦片，不需要申请 Key。它的作用只是帮助定向图和真实地理坐标对齐；正式实时显示不依赖公共地图底图，而是显示上传的定向图。

底图对齐保存的参数包括地图中心经纬度、地图 zoom、图片偏移、缩放、旋转、透明度和显示宽度。公共地图使用 WGS84 / Web Mercator，手机上报的 WGS84 坐标不会再转换成 GCJ-02。实时点位和轨迹回放会使用 Web Mercator 像素坐标进行换算。

## 公共地图校准

1. 可以输入场地经纬度并点击 `Go center`，也可以在 `Search place` 里搜索地点。
2. 点击搜索结果后，地图会移动到该地点并放置标记。
3. 拖动或滚轮缩放公共地图，找到真实场地。
4. 拖动、缩放、旋转定向图，让它和公共地图对齐。
5. 可关闭 `Reference map` 检查只显示定向图时的效果。
6. 点击 `Save alignment` 保存当前地图中心、zoom 和图片变换参数。

## Android App

用 Android Studio 打开：

```text
android
```

手机和服务器在同一局域网时，App 服务器地址填写电脑 IP，例如：

```text
http://192.168.1.10:3000
```

不要填写 `localhost`，因为那会指向手机自身。

Android 11 及以上需要到系统权限页面手动允许“始终允许定位”，否则息屏后台定位可能无法持续运行。

网页“App 接入”页会生成类似下面的 deep link：

```text
orienteer://join?code=ABC123&server=http%3A%2F%2F192.168.1.10%3A3000
```

手机安装 App 后打开该链接，会自动填入服务器地址和赛事码。

## 关键接口

```text
POST /api/events
GET  /api/events
GET  /api/events/:eventId

POST /api/events/:eventId/map-image
GET  /api/events/:eventId/map-image
PUT  /api/events/:eventId/map-transform

POST /api/events/:eventId/runners
GET  /api/events/:eventId/runners

POST /api/mobile/join
POST /api/location/report
POST /api/location/batch-report
GET  /api/events/:eventId/runners/:runnerId/track
GET  /api/events/:eventId/live

WS   /ws/events/:eventId/live
```

## App 加入赛事示例

Android App 会先用赛事 ID 或赛事码、姓名加入赛事，后端返回 `runnerId`，再开始后台定位。
也可以使用网页赛事列表中显示的短赛事码加入。
后端还会返回 `uploadToken`，App 会自动带上它进行定位上报，用户不需要手动填写。

```json
{
  "eventId": "event-id",
  "eventCode": "ABC123",
  "name": "张三",
  "deviceId": "android-device-uuid"
}
```

接口：

```text
POST /api/mobile/join
```

## 定位上报示例

```json
{
  "eventId": "event-id",
  "runnerId": "runner-id",
  "lat": 30.123456,
  "lng": 120.123456,
  "coordSystem": "WGS84",
  "accuracy": 8.5,
  "speed": 2.1,
  "heading": 86,
  "timestamp": 1780000000000
}
```

## 无真机验证

1. 启动服务并打开 `http://localhost:3000`。
2. 创建一个赛事。
3. 添加至少一个参赛者。
4. 上传一张底图，或直接使用默认网格背景。
5. 进入“实时大屏”。
6. 点击“模拟移动”，页面会通过 `/api/location/report` 给第一个参赛者追加一个位置点。
7. 打开“显示轨迹”后，可以看到轨迹线随模拟点增长。
8. 在“轨迹回放”里选择参赛者，拖动进度条或点击播放查看历史轨迹。

## 数据存储

MVP 使用本地 JSON 文件保存数据：

```text
data/store.json
public/uploads/maps/
```

后续正式化时应替换为 PostgreSQL/PostGIS，并把上传文件迁移到对象存储或受控文件服务。
