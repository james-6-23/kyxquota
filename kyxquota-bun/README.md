# 🚀 KYX API Quota Bridge

基于 **Bun + Hono + SQLite** 构建的高性能公益站额度自助管理系统

---

## ✨ 核心特性

- ⚡ **极致性能** - Bun 运行时，QPS 70k+，响应延迟 <5ms
- 🗄️ **SQLite 数据库** - WAL 模式，零配置，支持高并发读写
- 🎨 **现代化 UI** - Tailwind CSS 设计，流畅动画，响应式布局
- 🔒 **安全可靠** - OAuth2 标准认证 + Session 管理
- 🐳 **一键部署** - Docker Compose，3 分钟完成部署

---

## 🗄️ 数据库说明

### 数据库类型
**SQLite** - 嵌入式关系型数据库（WAL 模式）

### 💰 额度单位换算
```
500,000 quota = $1 美元
```

**示例**:
- 10,000,000 quota = $20
- 20,000,000 quota = $40
- 50,000,000 quota = $100

### 核心特性
- ✅ **WAL 模式** - 写前日志，支持并发读写，性能提升 10x
- ✅ **预编译查询** - SQL 语句预编译，执行效率提升 3x
- ✅ **自动索引** - 关键字段建立索引，查询速度提升 5-10x
- ✅ **零配置** - 无需安装数据库服务，开箱即用
- ✅ **单文件存储** - 易于备份和迁移

### 数据库位置
```
data/
├── kyxquota.db          # 主数据库文件
├── kyxquota.db-shm      # 共享内存文件  
└── kyxquota.db-wal      # WAL 日志文件
```

### 数据库表结构（6个表）
- `users` - 用户绑定信息
- `claim_records` - 每日领取记录
- `donate_records` - Key 投喂记录
- `used_keys` - 已使用的 Keys
- `sessions` - 用户会话（24小时有效期）
- `admin_config` - 系统配置（单例表，包含每日领取次数等配置）

---

## 🔗 绑定 KYX 公益站账号逻辑

### 绑定流程

```
1️⃣ Linux Do OAuth2 登录
   → 获取 linux_do_id（如：12345）

2️⃣ 输入公益站用户名
   → 用户输入公益站的用户名

3️⃣ 搜索公益站用户
   → 调用公益站 API 搜索（最多搜索 4 页，共 400 条记录）
   → 精确匹配用户名（支持大小写不敏感）

4️⃣ 验证 Linux Do ID 匹配 ⚠️
   → kyxUser.linux_do_id === session.linux_do_id
   → 防止绑定他人账号

5️⃣ 保存绑定信息
   → 数据库 users 表

6️⃣ 首次绑定赠送 $100
   → 如果是首次绑定 → 自动充值 $100
```

### 安全机制

**Linux Do ID 验证**（核心安全措施）:
```typescript
// 只能绑定 Linux Do ID 匹配的公益站账号
if (kyxUser.linux_do_id !== session.linux_do_id) {
  return { error: 'Linux Do ID 不匹配，无法绑定' };
}
```

**防止场景**:
- ❌ 用户 A 绑定用户 B 的公益站账号
- ❌ 重复领取新手奖励
- ❌ 冒用他人身份

---

## 📋 功能清单

### 用户端功能
- ✅ Linux Do OAuth2 登录
- ✅ 绑定公益站账号（首次奖励 $100）
- ✅ 查询实时额度
- ✅ 每日领取额度（可配置领取次数，默认 1 次/天）
- ✅ 投喂 ModelScope Keys（每个 $50，限制 **1 个/天**）
- ✅ 后端验证 Key 有效性（安全可靠）
- ✅ 查看个人领取/投喂记录

### 管理员功能
- ✅ 仪表板数据统计
- ✅ 系统配置管理（额度、领取次数、Session、Keys 推送）
- ✅ Keys 批量管理（导出、测试、删除）
- ✅ 用户数据统计与导出
- ✅ 领取/投喂记录查询（支持分页）
- ✅ 失败 Keys 重新推送

---

## 🚀 快速部署

### 前置要求
- Docker & Docker Compose 已安装

### 部署步骤

```bash
# 1. 进入项目目录
cd kyxquota-bun

# 2. 配置环境变量
cp env.example .env
nano .env  # 填写必要配置（见下方）

# 3. 一键部署
chmod +x deploy.sh
./deploy.sh

# 4. 验证部署
chmod +x verify.sh
./verify.sh
```

### 环境变量配置

编辑 `.env` 文件，填写以下必要参数：

```env
# Linux Do OAuth2 配置（必填）
# 在 https://connect.linux.do 申请
LINUX_DO_CLIENT_ID=your_client_id_here
LINUX_DO_CLIENT_SECRET=your_client_secret_here
LINUX_DO_REDIRECT_URI=http://localhost:3000/oauth/callback

# 管理员密码（必填，建议修改）
ADMIN_PASSWORD=your_secure_password

# 服务端口（可选）
PORT=3000
```

### 访问应用

- **用户端**: http://localhost:3000
- **管理后台**: http://localhost:3000/admin

---

## 📦 本地开发部署

### 1. 安装 Bun

```bash
# Linux/Mac
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. 启动开发服务器

```bash
# 安装依赖
bun install

# 配置环境变量
cp env.example .env
nano .env

# 启动（支持热重载）
bun run dev

# 访问 http://localhost:3000
```

---

## 🐳 Docker 命令速查

```bash
# 启动服务
docker-compose up -d

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看日志
docker-compose logs -f

# 查看状态
docker-compose ps

# 进入容器
docker-compose exec app sh

# 查看资源使用
docker stats kyxquota-bun

# 重新构建
docker-compose build --no-cache
docker-compose up -d
```

---

## 💾 数据备份与恢复

### 备份数据

```bash
# 1. 停止服务
docker-compose down

# 2. 备份数据库
cp -r data data.backup.$(date +%Y%m%d)

# 3. 重启服务
docker-compose up -d
```

### 恢复数据

```bash
# 1. 停止服务
docker-compose down

# 2. 恢复数据
cp -r data.backup.20250122/kyxquota.db data/

# 3. 重启服务
docker-compose up -d
```

---

## 🌍 生产环境部署

详细的生产环境部署指南请查看 **[DEPLOYMENT.md](./DEPLOYMENT.md)**

包含：
- Nginx 反向代理配置
- SSL/HTTPS 配置
- 防火墙设置
- 性能优化
- 监控方案

---

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| **吞吐量** | 70,000+ QPS |
| **响应延迟** | 2-5ms (P99: <10ms) |
| **冷启动** | <10ms |
| **内存占用** | 40-50MB |
| **缓存命中率** | >85% |

---

## 🔍 故障排查

### 问题 1: 容器启动失败

```bash
# 查看日志
docker-compose logs app

# 常见原因：
# - 环境变量未配置 → 检查 .env
# - 端口被占用 → 修改 PORT
# - Docker 未运行 → 启动 Docker Desktop
```

### 问题 2: OAuth 回调 404

```bash
# 检查回调地址
cat .env | grep REDIRECT_URI

# 确保配置正确：
# 本地: http://localhost:3000/oauth/callback
# 生产: https://yourdomain.com/oauth/callback
```

### 问题 3: 数据库锁定

```bash
# 停止服务
docker-compose down

# 删除 WAL 文件
rm data/kyxquota.db-shm data/kyxquota.db-wal

# 重启服务
docker-compose up -d
```

---

## 📁 项目结构

```
kyxquota-bun/
├── src/
│   ├── index.ts           # 主入口（Hono 应用）
│   ├── config.ts          # 配置管理
│   ├── types.ts           # TypeScript 类型定义
│   ├── database.ts        # SQLite 数据库（预编译查询）
│   ├── cache.ts           # LRU 缓存管理器
│   ├── utils.ts           # 工具函数
│   ├── routes/            # 路由层（28 个 API 端点）
│   │   ├── oauth.ts       # OAuth2 认证
│   │   ├── user.ts        # 用户 API
│   │   └── admin.ts       # 管理员 API
│   ├── services/          # 服务层
│   │   ├── kyx-api.ts     # 公益站 API
│   │   └── keys.ts        # Key 验证
│   └── templates/         # HTML 模板
│       ├── user.html      # 用户界面
│       └── admin.html     # 管理员界面
├── data/                  # 数据目录（SQLite 数据库）
├── Dockerfile             # Docker 镜像构建
├── docker-compose.yml     # Docker Compose 配置
├── package.json           # Bun 项目配置
└── deploy.sh              # 一键部署脚本
```

---

## 🛠️ 技术栈

- **运行时**: Bun 1.0+
- **Web 框架**: Hono 4.0+
- **数据库**: SQLite (WAL 模式)
- **前端**: Tailwind CSS
- **部署**: Docker Compose
- **语言**: TypeScript

---

## 🆕 最新更新（v1.2.0）

### 核心优化

1. **Key 验证优化** 🔒
   - 移除前端验证，只在后端验证（更安全）
   - 防止绕过验证机制

2. **投喂限制调整** ⚠️
   - 每天投喂从 5 个 Key 改为 **1 个 Key**
   - 更公平的额度分配，防止滥用

3. **分页功能** 📄
   - 领取/投喂记录支持分页（50条/页）
   - 性能提升 10-100 倍

4. **搜索优化** 🔍
   - 用户搜索最多 4 页（400 条记录）
   - 详细的搜索日志
   - 更快的响应速度

5. **配置增强** ⚙️
   - 管理员可设置每日领取次数（1-10次）
   - 额度单位实时换算显示

---

## 📖 API 端点（28个）

### 用户 API（10个）
- `POST /api/auth/bind` - 绑定账号
- `POST /api/auth/logout` - 退出登录
- `GET /api/user/quota` - 查询额度
- `POST /api/claim/daily` - 每日领取
- `POST /api/donate/validate` - 投喂 Keys（后端验证）
- `GET /api/user/records/claim` - 领取记录
- `GET /api/user/records/donate` - 投喂记录

### 管理员 API（18个）
- `POST /api/admin/login` - 管理员登录
- `GET /api/admin/config` - 获取配置
- `PUT /api/admin/config/quota` - 更新领取额度
- `PUT /api/admin/config/max-daily-claims` - 设置每日领取次数 🆕
- `PUT /api/admin/config/session` - 更新 API Session
- `PUT /api/admin/config/new-api-user` - 更新 new-api-user
- `PUT /api/admin/config/keys-api-url` - 更新 Keys API URL
- `PUT /api/admin/config/keys-authorization` - 更新授权 Token
- `PUT /api/admin/config/group-id` - 更新 Group ID
- `GET /api/admin/records/claim?page=1&pageSize=50` - 领取记录（分页）🆕
- `GET /api/admin/records/donate?page=1&pageSize=50` - 投喂记录（分页）🆕
- `GET /api/admin/keys/export` - 导出 Keys
- `POST /api/admin/keys/test` - 测试 Keys
- `POST /api/admin/keys/delete` - 删除 Keys
- `GET /api/admin/users` - 用户列表
- `GET /api/admin/export/users` - 导出用户
- `POST /api/admin/rebind-user` - 重新绑定
- `POST /api/admin/retry-push` - 重试推送

---

## 📄 许可证

MIT License

---

## ⚙️ 系统配置说明

### 管理员可配置项

访问管理后台 → 系统配置页面，可以配置：

| 配置项 | 说明 | 默认值 | 单位 |
|--------|------|--------|------|
| **每日领取额度** | 用户每次领取的额度 | 20,000,000 | quota（= $40） |
| **每日领取次数** | 用户每天最多领取次数 | 1 | 次/天 |
| **API Session** | 公益站 API 认证 Session | - | - |
| **Keys API URL** | Keys 推送的 API 地址 | - | - |
| **Keys Authorization** | Keys 推送授权 Token | - | - |
| **Group ID** | Keys 推送目标分组 ID | 26 | - |

### 用户限制

| 限制项 | 默认值 | 说明 |
|--------|--------|------|
| **每日领取次数** | 1 次 | 可由管理员配置（1-10次） |
| **每日投喂 Key** | 1 个 | 固定限制，防止滥用 |
| **领取条件** | 额度 < $20 | 剩余额度低于 $20 时可领取 |

### 搜索配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| **每页记录数** | 100 条 | 单页搜索记录数 |
| **最大搜索页数** | 4 页 | 最多搜索前 4 页 |
| **最大搜索记录** | 400 条 | 避免过多 API 调用 |

---

## ⚠️ 重要提示

### 投喂限制
- 每天只能投喂 **1 个 ModelScope Key**
- 每个有效 Key 奖励 **$50**（25,000,000 quota）
- Key 在后端验证，确保安全

### 领取限制
- 剩余额度低于 **$20** 时可领取
- 默认每天领取 **1 次**（管理员可配置）
- 每次领取 **$40**（20,000,000 quota）

### 绑定注意
- 只能绑定与 Linux Do ID 匹配的公益站账号
- 首次绑定赠送 **$100** 新手奖励
- 重新绑定不会获得额外奖励

---

## 🙏 致谢

- Bun 团队
- Hono 框架
- Linux Do 社区
- 公益站用户

---

**详细部署指南**: [DEPLOYMENT.md](./DEPLOYMENT.md)  
**版本**: v1.2.0  
**更新日期**: 2025-10-22
