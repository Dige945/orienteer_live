# 定向越野实时定位系统 Goal 模式开发文档

## 1. 项目目标

开发一个定向越野实时定位系统，使赛事组织者可以在网页端上传定向越野底图图片，将其与高德地图等真实地图对齐，并在定向底图上实时查看每名参与者的位置与轨迹。

系统应支持手机息屏后继续定位上传，因此参赛者定位端优先采用 App，而不是纯网页。

## 2. MVP 范围

第一版目标是做出可现场验证的最小可用系统：

- 网页管理端
  - 创建赛事
  - 上传定向底图图片
  - 在高德地图上叠加定向图
  - 支持拖动、缩放、旋转、透明度调整
  - 保存底图对齐参数
  - 实时显示所有参赛者位置
  - 查看参赛者轨迹

- 手机定位端
  - Android App 优先
  - 扫码或输入赛事码加入赛事
  - 输入姓名、号码或分组
  - 获取定位权限
  - 支持息屏后台定位
  - 定时上传 GPS 位置
  - 网络异常时本地缓存，恢复后补传

- 后端服务
  - 管理赛事、参赛者、底图、校准参数
  - 接收手机定位数据
  - 保存实时位置和历史轨迹
  - 通过 WebSocket 向网页端推送实时位置

## 3. 暂不做的内容

以下内容不进入 MVP，避免第一版复杂度过高：

- 不解析 OMAP、OCAD 等专业地图格式
- 不做竞赛成绩判定
- 不做自动打卡判点
- 不做 iOS App 首版
- 不做复杂多控制点局部变形校正
- 不做 App Store / 应用商店正式上架

## 4. 推荐技术栈

### 前端网页

- Vite
- React
- TypeScript
- 高德地图 JS API
- Canvas 或 SVG 覆盖层
- WebSocket 客户端

### Android App

- Kotlin 原生 Android，或 Flutter
- 首版建议 Kotlin 原生 Android，便于处理后台定位和前台服务
- 使用 Android Location / Fused Location Provider
- 使用前台服务保证息屏定位稳定性

### 后端

- Node.js + NestJS，或 Python + FastAPI
- WebSocket 实时推送
- PostgreSQL 保存业务数据
- PostGIS 可选，用于后续空间查询
- Redis 可选，用于缓存实时位置

### 部署

- HTTPS 必须启用
- 后端部署在云服务器
- 静态网页部署在同一服务器或对象存储/CDN
- 数据库定期备份

## 5. 系统架构

```text
Android App
  -> GPS 定位
  -> 后台上传位置
  -> HTTPS API

后端服务
  -> 保存轨迹
  -> 更新实时位置
  -> WebSocket 推送

网页管理端
  -> 上传定向图
  -> 对齐高德地图
  -> 实时显示参赛者
  -> 轨迹回放
```

## 6. 底图对齐方案

定向底图以图片形式上传，例如 PNG 或 JPG。

网页端将定向图作为半透明图层覆盖在高德地图上，管理员通过以下方式对齐：

- 拖动位置
- 缩放大小
- 旋转角度
- 调整透明度
- 保存对齐参数

MVP 保存的参数：

```json
{
  "mapImageUrl": "/uploads/maps/event-001.png",
  "anchorLng": 120.123456,
  "anchorLat": 30.123456,
  "offsetX": 0,
  "offsetY": 0,
  "scale": 1.0,
  "rotation": 0,
  "opacity": 0.65,
  "imageWidth": 3000,
  "imageHeight": 2200
}
```

第一版用整体变换完成对齐。后续可增加三点校准、多控制点拟合和局部变形修正。

## 7. 坐标处理原则

手机定位通常得到 WGS-84 坐标，高德地图使用 GCJ-02 坐标。系统必须明确坐标系转换，否则位置会偏移。

MVP 处理方式：

- App 上传原始 GPS 坐标和坐标系标记
- 后端统一转换为地图展示所需坐标
- 网页端使用统一后的坐标进行显示
- 在定向图上展示时，使用保存的底图变换参数把地图坐标转换为图片坐标

位置数据结构：

```json
{
  "eventId": "event-001",
  "runnerId": "runner-023",
  "lat": 30.123456,
  "lng": 120.123456,
  "coordSystem": "WGS84",
  "accuracy": 8.5,
  "speed": 2.1,
  "heading": 86,
  "battery": 73,
  "timestamp": 1780000000000
}
```

## 8. 后台定位要求

由于用户明确要求息屏可用，手机端不能只用网页/PWA。

Android App 必须实现：

- 请求前台定位权限
- 请求后台定位权限
- 启动前台服务
- 在通知栏显示定位服务运行状态
- 定时获取位置
- 低电量时降低上传频率
- 断网时写入本地队列
- 恢复网络后批量补传

建议定位频率：

| 模式 | 定位间隔 | 上传间隔 | 使用场景 |
| --- | ---: | ---: | --- |
| 实时模式 | 1 秒 | 1 秒 | 演示、短距离活动 |
| 比赛模式 | 3 秒 | 3-5 秒 | 常规训练或赛事 |
| 省电模式 | 10 秒 | 10-15 秒 | 长时间活动 |

## 9. 数据模型草案

### Event

```text
id
name
description
startTime
endTime
status
createdAt
updatedAt
```

### MapImage

```text
id
eventId
imageUrl
imageWidth
imageHeight
anchorLng
anchorLat
offsetX
offsetY
scale
rotation
opacity
createdAt
updatedAt
```

### Runner

```text
id
eventId
number
name
groupName
deviceId
status
createdAt
updatedAt
```

### LocationPoint

```text
id
eventId
runnerId
lat
lng
coordSystem
accuracy
speed
heading
battery
timestamp
createdAt
```

### RunnerLiveState

```text
runnerId
eventId
latestLat
latestLng
accuracy
speed
heading
battery
lastSeenAt
isOnline
```

## 10. API 草案

```text
POST /api/events
GET  /api/events
GET  /api/events/:eventId

POST /api/events/:eventId/map-image
GET  /api/events/:eventId/map-image
PUT  /api/events/:eventId/map-transform

POST /api/events/:eventId/runners
GET  /api/events/:eventId/runners

POST /api/location/report
POST /api/location/batch-report
GET  /api/events/:eventId/runners/:runnerId/track

WS   /ws/events/:eventId/live
```

## 11. 网页端页面

### 赛事列表页

- 展示已有赛事
- 创建新赛事
- 进入赛事管理

### 赛事管理页

- 编辑赛事信息
- 管理参赛者
- 上传定向底图
- 进入底图对齐
- 进入实时大屏

### 底图对齐页

- 显示高德地图
- 覆盖定向图图片
- 支持拖动、缩放、旋转、透明度调整
- 支持重置和保存
- 显示当前变换参数

### 实时大屏页

- 以定向底图为主视图
- 显示所有参赛者实时位置
- 显示姓名、号码、更新时间、GPS 精度
- 支持按分组筛选
- 支持显示/隐藏轨迹
- 支持离线状态提示

## 12. Android App 页面

### 加入赛事页

- 扫描二维码
- 或输入赛事码

### 参赛者信息页

- 输入姓名
- 输入号码
- 选择分组

### 定位运行页

- 显示当前赛事
- 显示定位状态
- 显示上传状态
- 显示 GPS 精度
- 显示电量
- 开始/停止定位

## 13. 验收标准

MVP 完成时应满足：

- 可以创建赛事
- 可以上传一张定向底图图片
- 可以将定向图覆盖到高德地图上并手动对齐
- 可以保存并重新加载对齐参数
- Android App 可以加入赛事
- Android App 可以在息屏后继续上传位置
- 网页实时大屏可以看到参赛者位置更新
- 断网恢复后 App 可以补传轨迹
- 可以查看单个参赛者历史轨迹

## 14. 开发里程碑

### Milestone 1: Web 基础框架

- 初始化前端项目
- 初始化后端项目
- 建立赛事 CRUD
- 建立基础数据库结构

### Milestone 2: 底图上传与对齐

- 实现图片上传
- 接入高德地图
- 实现图片覆盖层
- 实现拖动、缩放、旋转、透明度
- 保存和读取变换参数

### Milestone 3: 实时定位链路

- 实现定位上报 API
- 实现实时位置缓存
- 实现 WebSocket 推送
- 网页端显示实时人员位置

### Milestone 4: Android 定位 App

- 创建 Android App
- 实现赛事加入
- 实现后台定位
- 实现息屏上传
- 实现断网缓存

### Milestone 5: 轨迹与现场验证

- 实现轨迹保存
- 实现轨迹回放
- 做一次真实手机户外测试
- 根据 GPS 精度和耗电情况调整上传频率

## 15. 主要风险

- 林区 GPS 漂移明显，实际精度可能只有 5-30 米
- 手机厂商省电策略可能影响 Android 后台定位
- 高德 GCJ-02 与 GPS WGS-84 坐标系必须处理
- 定向图如果本身比例或局部形变不准确，整体对齐会有局部误差
- 实时位置属于敏感个人信息，需要明确授权和数据删除策略

## 16. Goal 模式推荐输入

可以将下面这段作为 Goal 模式的开发目标：

```text
目标：在当前项目中开发一个定向越野实时定位 MVP。

要求：
1. 网页端支持创建赛事、上传定向底图图片、在高德地图上叠加图片并通过拖动/缩放/旋转/透明度完成对齐。
2. 保存底图对齐参数，重新进入页面后能恢复对齐状态。
3. 后端提供赛事、底图、参赛者、定位上报和实时推送接口。
4. 网页实时大屏以定向底图为主视图，显示所有参赛者位置、更新时间和轨迹。
5. 手机定位端优先做 Android App，必须支持息屏后台定位、定时上传、断网缓存和恢复补传。
6. MVP 不解析 OMAP/OCAD，不做成绩判定，不做 iOS 首版。

请先完成整体项目骨架和 Web 端底图对齐功能，再继续实现实时定位链路和 Android 定位端。
每个阶段完成后运行必要检查，并说明已完成内容、剩余风险和下一步。
```

