# 当前 MVP 状态

## 已实现并通过本地 smoke 验证

- 创建赛事
- 自动生成赛事码
- 手机端用赛事码和姓名加入赛事
- 后端返回 `runnerId` 和 `uploadToken`
- 定位上报需要 `uploadToken`
- 上传定向底图图片
- 保存底图对齐参数
- 公共地图参照层
- 手动拖动、缩放、旋转、透明度调整定向图
- 实时位置 API
- WebSocket 实时推送
- 实时大屏显示人员位置
- 在线/离线状态
- 轨迹查询
- 轨迹显示和回放
- Android 项目结构
- Android 系统 `LocationManager` 后台定位实现
- Android 断网上报队列和恢复补传
- Android 加入赛事和定位上报只需要姓名，不需要号码/分组
- Android 中文扫码优先加入赛事，扫码成功后自动显示赛事名称，手动输入作为备用入口
- Android/后端定位上报不包含电池字段
- Android 首次打开只请求前台定位，点击开始时再引导后台定位设置
- 本机临时服务器启动脚本
- Cloudflare Tunnel 内网穿透脚本，默认使用 HTTP/2 传输以避开部分网络的 QUIC/UDP 不稳定问题
- VPS 部署文档和脚本
- 本地数据备份脚本

## 需要实机验证

- Android Studio 编译 APK
- Android 真机定位权限流程
- Android 锁屏后持续定位
- 国产 Android 后台运行/省电策略
- 断网后恢复补传
- Cloudflare Tunnel 公网地址下 App 上报
- 多手机同时上报
- 真实定向图和公共地图对齐精度
- 户外 GPS 漂移效果

## 暂未做或不在 MVP

- iOS App
- OMAP/OCAD 专业地图格式解析
- 自动打卡判点
- 成绩判定
- 多控制点局部形变校正
- PostgreSQL/PostGIS 正式数据库
- 用户账号和后台登录权限

## 推荐下一步实机测试流程

1. 在电脑运行：

```bat
start-local.cmd
```

2. 另开窗口运行：

```bat
start-tunnel.cmd
```

3. 打开网页：

```text
http://localhost:3000
```

4. 创建赛事。
5. 上传定向图。
6. 用公共地图完成对齐并保存。
7. 在 `App access` 里把 `App server URL` 改成 tunnel 输出的 HTTPS 地址。
8. 用 Android App 填 tunnel 地址、赛事码和姓名。
9. 开始后台定位。
10. 锁屏 10-30 分钟观察实时大屏。
11. 断网 1-3 分钟再恢复，检查轨迹是否补传。

## 当前自动检查

```bat
cmd /c npm run check
cmd /c npm run smoke
```

`smoke` 已覆盖单点定位上报和断网恢复场景使用的 `/api/location/batch-report` 批量补传。当前命令行 Java 是 8，直接运行 Android Gradle 会报 Android Gradle Plugin 需要 Java 11+；用 Android Studio 自带 JBR 17 编译，或把 `JAVA_HOME` 指向 JDK 17 后再运行 `gradlew.bat :app:assembleDebug`。
