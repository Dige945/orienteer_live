# Cloudflare Worker 迁移状态

这个目录是 Cloudflare 托管版本的后端骨架。

## 当前已实现

- `GET /api/health`
- `GET /api/diagnostics`
- `POST /api/admin/login`
- `GET /api/events`
- `POST /api/events`
- `GET /api/events/:eventId`
- `PUT /api/events/:eventId`
- `DELETE /api/events/:eventId`
- `GET /api/mobile/events/:eventIdOrCode`
- `GET /api/events/:eventId/runners`
- `POST /api/events/:eventId/runners`
- `PUT /api/events/:eventId/runners/:runnerId`
- `DELETE /api/events/:eventId/runners/:runnerId`
- `POST /api/mobile/join`
- `POST /api/location/report`
- `POST /api/location/batch-report`
- `GET /api/events/:eventId/live`
- `GET /api/events/:eventId/runners/:runnerId/track`
- `GET /api/events/:eventId/map-image`
- `POST /api/events/:eventId/map-image`
- `PUT /api/events/:eventId/map-transform`
- `WS /ws/events/:eventId/live`

## 当前底图方案

默认不使用 R2。底图上传后会以 `data:` URL 存到 Durable Object Storage，适合当前“单赛事、每次一张底图”的最低成本方案。

建议上传前把定向底图压缩到 1-2MB 以内，图片太大时 Worker 请求体和 Durable Object 存储会更容易碰到限制。

后续如果要长期保存很多赛事底图，再改回 R2。R2 版本需要在 `wrangler.toml` 加回：

```toml
[[r2_buckets]]
binding = "MAPS"
bucket_name = "orienteer-maps"
```

并创建 bucket：

```bat
wrangler r2 bucket create orienteer-maps
```

## 本地调试

安装 Wrangler 后：

```bat
npm install -g wrangler
cd cloudflare\worker
wrangler dev
```

默认管理员密码在 `wrangler.toml`：

```toml
[vars]
ADMIN_PASSWORD = "admin123"
```

## 部署

```bat
cd cloudflare\worker
wrangler deploy
```

部署后需要把 Pages 的 `/api/*` 和 `/ws/*` 路由指到这个 Worker，或者直接把 Worker 绑定到同一个域名。

## 部署后验证

只读验证，不会改赛事：

```bat
set CF_BASE=https://你的域名
npm run cf:smoke
```

完整写入验证会新建并删除一个测试赛事。因为当前是单赛事模式，这个命令会清空当前赛事，只能在空环境或测试环境运行：

```bat
set CF_BASE=https://你的域名
set ADMIN_PASSWORD=你的管理员密码
npm run cf:smoke:write
```
