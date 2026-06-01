# Android 定位端

首版目标是用 Android App 支持息屏后台定位，并向 Web 后端持续上报位置。当前目录已经是 Android Studio 可打开的 Gradle 项目。

## 打开方式

用 Android Studio 打开 `android` 目录，而不是项目根目录。

首次同步会下载：

- Android Gradle Plugin 8.5.2
- Kotlin Android Plugin 1.9.24

命令行编译需要 Java 11 或更高版本，建议 Java 17。Android Studio 一般会使用自带 JBR 17；如果在命令行运行 `gradlew.bat :app:assembleDebug` 时看到 Java 8 报错，需要在 Android Studio 里编译，或把 `JAVA_HOME` 指向 JDK 17。

## 必须能力

- 已请求前台定位权限
- 已请求后台定位权限
- 已使用前台服务保持息屏定位
- 已在通知栏展示定位运行状态
- 已使用 Android 系统 LocationManager 获取真实位置
- 已定时上报位置到 `/api/location/report`
- 已在失败时写入 App 私有文件队列
- 已在恢复后优先调用 `/api/location/batch-report` 补传

## 后端配置

App 界面默认使用扫码加入，不要求参赛者手动填写服务器地址。网页端 `App access` 里生成的二维码内容类似：

```text
orienteer://join?code=ABC123&server=https%3A%2F%2Fxxxx.trycloudflare.com
```

扫码成功后，App 会自动解析服务器地址和赛事码，并请求后端显示赛事名称。扫码不可用时，可以点“手动输入”展开备用输入。

App 内部保存：

```text
serverBaseUrl
eventId
eventCode
name
```

界面只要求参赛者填写姓名。定位服务默认每 2 秒上报一次，首版不在手机界面暴露上报间隔设置，避免现场使用时误填。

App 启动定位前会调用：

```text
POST /api/mobile/join
```

后端返回 `runnerId` 后，App 再启动前台定位服务并开始上报。
输入框支持填写完整赛事 ID，也支持填写网页端显示的短赛事码。
后端同时返回 `uploadToken`，App 会自动保存到定位服务参数里，用户不需要填写。
App 也支持 deep link：

```text
orienteer://join?code=ABC123&server=http%3A%2F%2F192.168.1.10%3A3000
```

打开链接后会自动填入服务器地址和赛事码。

本机调试时，手机和电脑需要在同一局域网。App 里的服务器地址不要写 `localhost`，应写电脑局域网 IP，例如：

```text
http://192.168.1.10:3000
```

当前 `network_security_config.xml` 允许 HTTP 明文流量，便于局域网测试。正式部署应改为 HTTPS。

## 真机权限注意

Android 11 及以上后台定位不能直接在弹窗里一次授权。App 会打开系统应用详情页，用户需要在权限里手动选择“始终允许”。
点击开始定位前，App 会检查前台定位和后台定位权限；缺少后台定位时会跳转到系统应用设置。

国产 Android 设备还建议检查：

- 允许后台运行
- 关闭对此 App 的严格省电
- 允许自启动或后台活动
- 锁屏后不要清理该 App

## 下一步

1. 在 Android Studio 中同步并编译。
2. 真机安装后输入服务器地址、赛事 ID 或赛事码、姓名。
3. 点击开始后台定位。
4. 息屏 10-30 分钟，观察网页实时大屏位置是否持续更新。
5. 断开网络一段时间后恢复，检查轨迹是否补传。

当前实现不依赖 Google Play Services，优先使用系统 GPS_PROVIDER 和 NETWORK_PROVIDER，更适合国产 Android 设备。部分厂商仍可能需要在系统电池设置里允许后台运行和自启动。
