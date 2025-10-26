# 🔧 GitHub 工作流修复指南

## 🎯 问题

GitHub Actions 构建的镜像可能没有包含最新的 `ctrl.gif` 文件。

## ✅ 解决方案

### 方法 1：推送代码触发重新构建（推荐）

```bash
# 1. 确认 ctrl.gif 文件存在且未被忽略
git status

# 2. 如果 ctrl.gif 未被跟踪，添加它
git add public/ctrl.gif

# 3. 提交所有更改
git add .
git commit -m "🔧 修复: 添加 ctrl.gif 文件和优化部署流程

- 添加 ctrl.gif 背景文件 (16MB)
- 优化静态文件服务，添加日志和 CORS
- 添加启动时文件检查功能
- 优化 Nginx 反向代理配置
- 添加自动化部署脚本"

# 4. 推送到 GitHub
git push origin main
```

### 方法 2：手动触发 GitHub Actions

1. 访问：https://github.com/james-6-23/kyxquota/actions
2. 选择 "Build Docker Image" 工作流
3. 点击 "Run workflow" > "Run workflow"
4. 等待构建完成（约 5-10 分钟）

### 方法 3：在服务器使用本地构建（临时方案）

```bash
# 修改部署命令，使用本地构建
docker-compose down
docker-compose -f docker-compose.build.yml up -d --build
```

---

## 🔍 验证 GitHub Actions 构建

### 检查构建是否成功

1. **查看 Actions 状态**
   - 访问：https://github.com/james-6-23/kyxquota/actions
   - 确认最新的构建是 ✅ 绿色（成功）

2. **查看构建日志**
   ```
   检出代码 → 设置 Docker Buildx → 登录 GHCR → 构建并推送
   ```

3. **确认文件被复制**
   在构建日志中搜索：
   ```
   COPY public ./public
   ```

### 拉取最新镜像

```bash
# 在服务器上
cd ~/kyxquota

# 停止容器
docker-compose down

# 拉取最新镜像（重要！）
docker-compose pull

# 启动服务
docker-compose up -d

# 验证镜像时间
docker images | grep kyxquota
# 查看 CREATED 列，应该是最新时间

# 验证容器内文件
docker exec kyxquota-bun ls -la /app/public/ctrl.gif
```

---

## ⚠️ 常见问题

### Q1: Git 提示 ctrl.gif 文件太大

**解决方案 A**：使用 Git LFS（大文件存储）

```bash
# 安装 Git LFS
git lfs install

# 跟踪大文件
git lfs track "*.gif"
git add .gitattributes

# 提交
git add public/ctrl.gif
git commit -m "添加 ctrl.gif (使用 Git LFS)"
git push origin main
```

**解决方案 B**：使用 CDN 存储（推荐）

```bash
# 将 gif 上传到 Cloudflare R2 或其他 CDN
# 然后在代码中使用 CDN URL
```

### Q2: GitHub Actions 构建失败

**检查**：
1. Dockerfile 中的 `COPY public ./public` 是否存在
2. `.dockerignore` 是否排除了 public 目录
3. GitHub 仓库是否有 `ctrl.gif` 文件

### Q3: 拉取镜像后还是 404

**可能原因**：
1. 缓存问题 - 使用 `docker-compose pull` 强制拉取
2. 容器没有重启 - 使用 `docker-compose up -d` 重启
3. Cloudflare 缓存 - 清除 CDN 缓存

---

## 📊 完整的部署流程

### 本地开发（Windows）

```bash
# 1. 开发和测试
git add .
git commit -m "你的提交信息"
git push origin main
```

### GitHub Actions（自动）

```
触发构建 → 克隆代码 → 构建镜像 → 推送到 GHCR
```

### 服务器部署（Linux）

```bash
# 方法 A：使用 GitHub 镜像（推荐）
docker-compose down
docker-compose pull
docker-compose up -d

# 方法 B：本地构建
docker-compose -f docker-compose.build.yml down
docker-compose -f docker-compose.build.yml build --no-cache
docker-compose -f docker-compose.build.yml up -d
```

---

## 🎯 当前推荐做法

**立即执行**：

```bash
# 本地（Windows）
git status
git add public/ctrl.gif src/index.ts nginx-quota-optimized.conf
git commit -m "🔧 修复 GIF 加载和优化部署"
git push origin main

# 等待 5-10 分钟，GitHub Actions 构建完成

# 服务器（Linux）
cd ~/kyxquota
docker-compose down
docker-compose pull  # 拉取最新镜像
docker-compose up -d

# 验证
docker exec kyxquota-bun ls -la /app/public/ctrl.gif
curl -I http://localhost:2003/ctrl.gif
```

---

## 🔍 调试命令

```bash
# 查看使用的镜像
docker-compose config

# 查看镜像详情
docker images ghcr.io/james-6-23/kyxquota-bun

# 查看容器内文件
docker exec kyxquota-bun find /app -name "*.gif"

# 查看容器内 public 目录
docker exec kyxquota-bun ls -lah /app/public/

# 测试容器内访问
docker exec kyxquota-bun curl -I http://localhost:3000/ctrl.gif
```

---

## ✅ 成功标志

1. ✅ GitHub Actions 构建成功（绿色 ✓）
2. ✅ `docker-compose pull` 下载了新镜像
3. ✅ 容器内存在文件：`/app/public/ctrl.gif`
4. ✅ `curl -I http://localhost:2003/ctrl.gif` 返回 200
5. ✅ 浏览器可以访问：`https://quota.kyx03.de/ctrl.gif`

---

## 🎁 优化建议

### 1. 添加 .gitattributes（处理大文件）

```bash
cat > .gitattributes << 'EOF'
*.gif filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
EOF
```

### 2. 优化 GitHub Actions（添加验证步骤）

在 `.github/workflows/docker-build.yml` 添加：

```yaml
- name: 验证镜像内容
  run: |
    docker run --rm ghcr.io/${{ github.repository_owner }}/kyxquota-bun:latest ls -la /app/public/ctrl.gif
```

### 3. 使用 CDN（长期方案）

将 16MB 的 GIF 文件上传到 Cloudflare R2 或其他 CDN，减小镜像大小。


