# 服务器部署指南（零基础版）

> 目标：把你的代码部署到一台 Alibaba Linux 2C4G 服务器上，让同事可以通过浏览器访问。

## 整体流程

```
你的代码 → 推送到 GitHub → GitHub 自动构建镜像 → 服务器下载镜像 → 启动运行
```

**你不需要在服务器上写代码、编译代码，只需要复制粘贴命令。**

---

## 第一步：把代码推送到 GitHub

1. 去 [GitHub](https://github.com) 注册/登录账号。
2. 新建一个仓库，例如 `sales-map`。
3. 把本地代码推上去：

```bash
cd /Users/chenglimin/workspace/danfo/boss/map
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/你的用户名/sales-map.git
git push -u origin main
```

> 如果你不会用 git，也可以直接把项目文件夹拖拽到 GitHub 网页上传。

---

## 第二步：在 GitHub 添加密钥

1. 打开仓库页面 → 点击右上角 **Settings** → 左侧 **Secrets and variables** → **Actions**。
2. 点击 **New repository secret**，添加下面这个密钥：

| 名称 | 值 | 说明 |
|------|-----|------|
| `VITE_AMAP_KEY` | 你的高德地图 Key | 前端地图需要 |

> 高德 Key 获取：[高德开放平台](https://console.amap.com/dev/key/app) → 创建应用 → 添加 Web端(JS API) Key。

添加好后，每次你推送代码到 `main` 分支，GitHub 就会自动构建 backend 和 frontend 的 Docker 镜像，并推送到 GitHub Container Registry（免费）。

---

## 第三步：准备服务器

你需要一台 Linux 服务器，例如：
- 阿里云 ECS
- 腾讯云 CVM
- 华为云 ECS

**最低配置**：1 核 2G 就能跑，建议 2 核 4G。

你需要拿到以下信息：
- 服务器公网 IP（例如 `123.45.67.89`）
- root 密码（或 SSH 密钥）

---

## 第四步：生成 GitHub Token

1. 打开 [https://github.com/settings/tokens](https://github.com/settings/tokens)
2. 点击 **Generate new token (classic)**
3. 勾选以下权限：
   - `read:packages`（拉取镜像）
   - `write:packages`（如果需要手动推送镜像）
4. 点击 Generate，**复制并保存好这个 token**（只会显示一次）

---

## 第五步：登录服务器并执行部署

### 5.1 登录服务器

Mac 用户打开终端，Windows 用户可以用 PowerShell 或 XShell，执行：

```bash
ssh root@你的服务器IP
```

输入 root 密码登录。

### 5.2 下载并编辑部署脚本

```bash
curl -fsSL https://raw.githubusercontent.com/你的用户名/sales-map/main/scripts/deploy.sh -o /root/deploy.sh
```

然后用编辑器打开：

```bash
vi /root/deploy.sh
```

找到开头这几行，改成你自己的信息：

```bash
GHCR_OWNER="你的GitHub用户名"
GITHUB_TOKEN="你的GitHub Token"
AMAP_KEY="你的高德地图Key"
SERVER_IP="你的服务器公网IP"
```

按 `i` 进入编辑，改好后按 `Esc`，再输入 `:wq` 保存退出。

> 如果你不会用 vi，可以用下面这个命令直接替换（把值改成你的）：
>
> ```bash
> sed -i 's/你的GitHub用户名/zhangsan/g; s/你的GitHub Token/ghp_xxxx/g; s/你的高德地图Key/xxxxxxxx/g; s/你的服务器公网IP/123.45.67.89/g' /root/deploy.sh
> ```

### 5.3 执行部署

```bash
bash /root/deploy.sh
```

等待几分钟，看到 `✅ 部署完成！` 就是成功了。

---

## 第六步：访问系统

打开浏览器，访问：

```
http://你的服务器IP:5173
```

例如：`http://123.45.67.89:5173`

---

## 常见问题

### 1. 端口访问不了

检查服务器安全组/防火墙是否放行了 5173、3000、5433 端口。

阿里云路径：ECS 控制台 → 安全组 → 配置规则 → 入方向 → 添加规则。

### 2. 忘记数据库密码

密码保存在服务器 `/root/sales-map/.env` 文件中：

```bash
cat /root/sales-map/.env
```

### 3. 怎么看日志

```bash
cd /root/sales-map
docker compose logs -f backend   # 后端日志
docker compose logs -f frontend  # 前端日志
docker compose logs -f postgres  # 数据库日志
```

### 4. 更新了代码怎么重新部署

只需要把新代码推送到 GitHub，等待 GitHub Actions 构建完成（约 5~10 分钟），然后在服务器执行：

```bash
cd /root/sales-map
docker compose pull
docker compose up -d
```

---

## 需要我帮你做什么？

如果你还是不会，可以把下面信息发给我，我可以继续帮你：
1. GitHub 用户名
2. 高德地图 Key
3. 服务器公网 IP
4. 是否有 GitHub 仓库了？
