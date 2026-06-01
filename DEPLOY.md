# 实机使用和最低成本部署

## 结论

这个项目实机可用，但手机必须能访问到运行 `server.js` 的 Node 服务。

GitHub Pages 不适合作为完整部署方案，因为它只能托管静态网页，不能运行本项目需要的后端 API、WebSocket、图片上传和轨迹存储。可以把前端静态文件放 GitHub Pages，但后端仍然需要单独部署。

## 方案 1: 同一 Wi-Fi 局域网测试

适合训练场地、学校、办公室、手机和电脑在同一 Wi-Fi 的情况。

1. 在电脑 Command Prompt 中运行：

```bat
npm start
```

2. 观察启动日志里的 `LAN access`，例如：

```text
LAN access: http://192.168.1.10:3000
```

3. 电脑浏览器打开：

```text
http://localhost:3000
```

4. 手机 App 服务器地址填写：

```text
http://192.168.1.10:3000
```

注意：不要在手机里填 `localhost`。

优点：

- 成本最低
- 不需要公网服务器
- 延迟低

缺点：

- 手机必须和电脑同网
- 离开局域网就不能访问
- Windows 防火墙可能需要允许 Node.js 入站

## 方案 2: 本机服务 + Cloudflare Tunnel

适合想快速公网实机测试，但不想买服务器。

思路：

```text
你的电脑运行 Node 服务
Cloudflare Tunnel 提供一个临时 HTTPS 公网地址
手机 App 填这个公网地址
```

基本步骤：

1. 启动项目：

```bat
npm start
```

2. 另开一个 Command Prompt，启动 tunnel：

```bat
cloudflared tunnel --url http://localhost:3000
```

也可以运行：

```bat
start-tunnel.cmd
```

如果没有安装 `cloudflared`，Windows 可先运行：

```bat
winget install Cloudflare.cloudflared
```

安装后重新打开 Command Prompt。

3. 复制输出里的 `https://...trycloudflare.com` 地址。

4. 手机 App 服务器地址填写该 HTTPS 地址。

优点：

- 通常免费
- 不需要买服务器
- 手机不需要和电脑同一个 Wi-Fi
- HTTPS 地址更适合移动端

缺点：

- 临时地址会变
- 电脑必须一直开机
- 网络质量取决于 tunnel

## 方案 3: 低成本 VPS

适合正式训练、多人活动、小型赛事。

最低配置建议：

```text
1 核 CPU
1 GB 内存
20 GB 磁盘
Ubuntu
```

部署方式：

```text
Node.js + npm
pm2 或 systemd 保活
Nginx 反代
HTTPS 证书
```

优点：

- 稳定
- 有固定域名
- 适合多人同时使用

缺点：

- 需要服务器费用
- 需要一点运维

### Ubuntu VPS 快速部署

准备：

- Ubuntu 22.04 或 24.04
- 1 核 1G 以上
- 服务器安全组开放 `80`，临时测试可开放 `3000`

在服务器上执行：

```bash
sudo bash deploy/ubuntu-setup.sh
```

把项目文件上传到：

```text
/opt/orienteer-live
```

进入项目目录：

```bash
cd /opt/orienteer-live
npm install --omit=dev
PORT=3000 pm2 start server.js --name orienteer-live
pm2 save
pm2 startup systemd
```

配置 Nginx：

```bash
sudo cp deploy/nginx-orienteer.conf /etc/nginx/sites-available/orienteer-live
sudo ln -s /etc/nginx/sites-available/orienteer-live /etc/nginx/sites-enabled/orienteer-live
sudo nginx -t
sudo systemctl reload nginx
```

访问：

```text
http://服务器公网IP
```

手机 App 服务器地址也填写：

```text
http://服务器公网IP
```

### 域名和 HTTPS

如果你有域名，把域名 A 记录指向 VPS 公网 IP。

然后安装证书：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.example
```

之后手机 App 服务器地址填写：

```text
https://your-domain.example
```

### 常用运维命令

```bash
pm2 status
pm2 logs orienteer-live
pm2 restart orienteer-live
pm2 stop orienteer-live
```

### 数据持久化和备份

当前 MVP 使用本地文件保存数据：

```text
data/store.json
public/uploads/maps/
```

这些文件包含赛事、参赛者、轨迹、底图和校准参数。重装服务器、删除项目目录或重新部署时要先备份。

手动备份：

```bash
sudo bash deploy/backup.sh
```

默认备份到：

```text
/opt/orienteer-backups/
```

建议加定时任务：

```bash
sudo crontab -e
```

每天凌晨 3 点备份：

```text
0 3 * * * APP_DIR=/opt/orienteer-live BACKUP_DIR=/opt/orienteer-backups bash /opt/orienteer-live/deploy/backup.sh
```

正式长期使用时，建议后续把本地 JSON 替换为 PostgreSQL/PostGIS。

## 不推荐只用 GitHub Pages

GitHub Pages 可以托管静态 HTML/CSS/JS，但本项目还需要：

- `POST /api/events`
- 图片上传
- `POST /api/location/report`
- WebSocket 实时推送
- 轨迹保存

这些都需要后端服务，所以不能只靠 GitHub Pages 完整运行。

## 当前推荐

第一次实机测试：

```text
方案 1: 同一 Wi-Fi 局域网测试
```

这也是最低成本的日常使用方式：每次训练或活动开始前，在自己的电脑上启动服务；活动结束后关闭服务。网页不是一直在线，只有电脑开着并运行服务时可访问。

Windows 可直接在项目目录运行：

```bat
start-local.cmd
```

或手动运行：

```bat
npm start
```

如果手机不在同一网络：

```text
方案 2: Cloudflare Tunnel
```

如果你希望“别人的手机也能远程连接”，推荐直接用：

```text
本机 npm start + Cloudflare Tunnel
```

需要保持两个窗口都开着：

```text
窗口 1: start-local.cmd
窗口 2: start-tunnel.cmd
```

Cloudflare Tunnel 输出的 `https://*.trycloudflare.com` 地址就是手机 App 服务器地址。

如果要稳定给多人长期使用：

```text
方案 3: VPS
```
