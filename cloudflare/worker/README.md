# Cloudflare Worker 迁移状态

这个目录是 Cloudflare 托管版本的后端。当前采用一个 Worker 同时托管网页静态文件和 API：

```text
https://xxx.workers.dev/
https://xxx.workers.dev/api/...
https://xxx.workers.dev/ws/...
```

这样不需要额外创建 Cloudflare Pages 项目，也不需要配置 `_redirects` 代理。

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

默认管理员密码是代码里的 fallback：

```text
admin123
```

正式使用前建议改成 Worker Secret，不要把密码写进 GitHub：

```bat
cd cloudflare\worker
wrangler secret put ADMIN_PASSWORD
```

## 部署

```bat
npm run cf:worker:deploy
```

部署成功后，命令行会输出一个 `workers.dev` 地址。这个地址就是网页地址，也是手机扫码里面的服务器地址。

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
