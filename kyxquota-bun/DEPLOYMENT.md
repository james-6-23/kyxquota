# 🚀 KYX API Quota Bridge - 部署指南

## 📋 项目信息

- **技术栈**: Bun + Hono + SQLite
- **数据库**: SQLite（WAL 模式）
- **部署方式**: Docker Compose
- **前端框架**: Tailwind CSS

---

## 🎯 快速部署（3 分钟）

### 步骤 1: 配置环境变量

```bash
# 1. 进入项目目录
cd kyxquota-bun

# 2. 复制环境变量模板
cp env.example .env

# 3. 编辑 .env 文件（Windows）
notepad .env

# 或（Linux/Mac）
nano .env
```

**必须配置的环境变量**:

```env
# Linux Do OAuth2 配置（必填）
LINUX_DO_CLIENT_ID=your_client_id_here
LINUX_DO_CLIENT_SECRET=your_client_secret_here
LINUX_DO_REDIRECT_URI=http://localhost:3000/oauth/callback

# 管理员密码（必填，建议修改）
ADMIN_PASSWORD=your_secure_password
```

> 💡 OAuth2 配置在 https://connect.linux.do 申请

### 步骤 2: 启动服务

```bash
# Windows PowerShell
.\deploy.sh

# Linux/Mac/Git Bash
chmod +x deploy.sh
./deploy.sh
```

### 步骤 3: 验证部署

```bash
# 运行验证脚本
chmod +x verify.sh
./verify.sh

# 或手动验证
curl http://localhost:3000
curl http://localhost:3000/admin
```

---

## 🌐 访问应用

部署成功后访问：

- **用户端**: http://localhost:3000
- **管理后台**: http://localhost:3000/admin

---

## 📊 数据库说明

### 数据库类型
**SQLite** - 嵌入式关系型数据库

### 为什么选择 SQLite？
- ✅ **零配置** - 无需安装数据库服务
- ✅ **高性能** - WAL 模式支持高并发
- ✅ **轻量级** - 单文件，易于备份
- ✅ **可靠性** - 久经考验的数据库引擎
- ✅ **低成本** - 无需额外资源

### 数据库特性
- **WAL 模式** - 写前日志，支持并发读写
- **预编译查询** - SQL 语句预编译，性能提升 3x
- **自动索引** - 关键字段建立索引
- **事务支持** - ACID 特性完整

### 数据库位置
```
data/
├── kyxquota.db          # 主数据库文件
├── kyxquota.db-shm      # 共享内存文件
└── kyxquota.db-wal      # WAL 日志文件
```

### 数据库表结构
```sql
-- 用户表
users (
  id INTEGER PRIMARY KEY,
  linux_do_id TEXT UNIQUE,
  username TEXT,
  kyx_user_id INTEGER,
  created_at INTEGER
)

-- 领取记录表
claim_records (
  id INTEGER PRIMARY KEY,
  linux_do_id TEXT,
  username TEXT,
  quota_added INTEGER,
  timestamp INTEGER,
  date TEXT
)

-- 投喂记录表
donate_records (
  id INTEGER PRIMARY KEY,
  linux_do_id TEXT,
  username TEXT,
  keys_count INTEGER,
  total_quota_added INTEGER,
  timestamp INTEGER,
  push_status TEXT,
  push_message TEXT,
  failed_keys TEXT
)

-- 已使用 Key 表
used_keys (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE,
  linux_do_id TEXT,
  username TEXT,
  timestamp INTEGER
)

-- Session 表
sessions (
  id TEXT PRIMARY KEY,
  data TEXT,
  expires_at INTEGER
)

-- 管理员配置表
admin_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session TEXT,
  new_api_user TEXT,
  claim_quota INTEGER,
  keys_api_url TEXT,
  keys_authorization TEXT,
  group_id INTEGER,
  updated_at INTEGER
)
```

---

## 🔧 Docker 命令

### 基本操作

```bash
# 启动服务
docker-compose up -d

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f app

# 进入容器
docker-compose exec app sh
```

### 数据管理

```bash
# 备份数据库
docker-compose down
cp -r data data.backup.$(date +%Y%m%d)

# 恢复数据库
cp -r data.backup.20250122/kyxquota.db data/

# 重启服务
docker-compose up -d
```

### 清理操作

```bash
# 停止并删除容器
docker-compose down

# 删除所有数据（谨慎！）
docker-compose down -v
rm -rf data/*

# 重新构建
docker-compose build --no-cache
docker-compose up -d
```

---

## 🌍 生产环境部署

### 1. 配置域名

在 `.env` 中修改回调地址：

```env
LINUX_DO_REDIRECT_URI=https://yourdomain.com/oauth/callback
```

### 2. 配置 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. 配置 SSL（使用 Certbot）

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx

# 自动配置 SSL
sudo certbot --nginx -d yourdomain.com

# 自动续期
sudo certbot renew --dry-run
```

### 4. 防火墙配置

```bash
# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 禁止直接访问应用端口
sudo ufw deny 3000/tcp
```

---

## 🔍 故障排查

### 问题 1: 容器启动失败

```bash
# 查看详细日志
docker-compose logs app

# 常见原因：
# - 环境变量未配置 → 检查 .env 文件
# - 端口被占用 → 修改 .env 中的 PORT
# - Docker 未运行 → 启动 Docker Desktop
```

### 问题 2: OAuth 回调 404

```bash
# 检查回调地址
cat .env | grep REDIRECT_URI

# 确保配置正确：
# 本地测试: http://localhost:3000/oauth/callback
# 生产环境: https://yourdomain.com/oauth/callback
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

### 问题 4: 查看数据库内容

```bash
# 进入容器
docker-compose exec app sh

# 使用 Bun SQLite 查询
bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('data/kyxquota.db');
console.log('用户数:', db.query('SELECT COUNT(*) as count FROM users').get());
console.log('领取记录:', db.query('SELECT COUNT(*) as count FROM claim_records').get());
console.log('投喂记录:', db.query('SELECT COUNT(*) as count FROM donate_records').get());
console.log('Keys数:', db.query('SELECT COUNT(*) as count FROM used_keys').get());
"
```

---

## 📈 性能优化

### 数据库优化

```bash
# 1. 定期清理过期 Session（已自动执行）

# 2. 分析数据库
docker-compose exec app sh -c "
bun -e \"
const { Database } = require('bun:sqlite');
const db = new Database('data/kyxquota.db');
db.exec('ANALYZE');
console.log('数据库分析完成');
\"
"

# 3. 压缩数据库
docker-compose exec app sh -c "
bun -e \"
const { Database } = require('bun:sqlite');
const db = new Database('data/kyxquota.db');
db.exec('VACUUM');
console.log('数据库压缩完成');
\"
"
```

### 监控性能

```bash
# 查看容器资源使用
docker stats kyxquota-bun

# 查看数据库大小
ls -lh data/kyxquota.db

# 查看缓存统计（访问管理后台查看）
curl http://localhost:3000/api/admin/config
```

---

## 🔄 数据迁移

### 从 Deno Deploy 迁移

如果你有现有的 Deno Deploy 数据：

```bash
# 1. 从旧系统导出数据
# 访问旧系统管理后台 → 导出用户数据

# 2. 准备导入脚本
cat > migrate.ts << 'EOF'
import { Database } from 'bun:sqlite';
const db = new Database('./data/kyxquota.db');

// 读取导出的 JSON 文件
const data = await Bun.file('export.json').json();

// 导入用户数据
const insertUser = db.prepare(
  'INSERT OR REPLACE INTO users (linux_do_id, username, kyx_user_id, created_at) VALUES (?, ?, ?, ?)'
);

for (const user of data.users) {
  insertUser.run(
    user.linux_do_id,
    user.username,
    user.kyx_user_id,
    user.created_at
  );
}

console.log(`导入完成: ${data.users.length} 个用户`);
EOF

# 3. 执行导入
bun migrate.ts
```

---

## 📦 本地开发部署

### 安装 Bun

```bash
# Linux/Mac
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 启动开发服务器

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp env.example .env
nano .env

# 3. 启动（支持热重载）
bun run dev

# 4. 访问
# http://localhost:3000
```

---

## 🔐 安全配置

### 1. 修改管理员密码

```env
ADMIN_PASSWORD=your_very_secure_password_here
```

### 2. 限制管理后台访问

在 Nginx 配置中添加 IP 白名单：

```nginx
location /admin {
    allow 123.456.789.0/24;  # 允许的 IP 段
    deny all;                 # 拒绝其他
    proxy_pass http://localhost:3000;
}
```

### 3. 启用 HTTPS

参考上面"生产环境部署"部分的 SSL 配置。

---

## 📊 监控和维护

### 日志管理

```bash
# 查看实时日志
docker-compose logs -f

# 查看最后 100 行
docker-compose logs --tail=100

# 查看特定时间段的日志
docker-compose logs --since="2025-01-22T10:00:00"

# 导出日志
docker-compose logs > logs_$(date +%Y%m%d).txt
```

### 定期维护

```bash
# 每周执行一次数据库优化
docker-compose exec app sh -c "
bun -e \"
const { Database } = require('bun:sqlite');
const db = new Database('data/kyxquota.db');
db.exec('VACUUM');
db.exec('ANALYZE');
console.log('数据库优化完成');
\"
"

# 每月备份数据
tar -czf backup_$(date +%Y%m%d).tar.gz data/
```

---

## 🆘 紧急恢复

### 服务异常

```bash
# 1. 停止服务
docker-compose down

# 2. 检查数据完整性
ls -lh data/

# 3. 恢复最近的备份
cp -r data.backup.20250122/* data/

# 4. 重启服务
docker-compose up -d

# 5. 验证
./verify.sh
```

### 数据损坏

```bash
# 1. 停止服务
docker-compose down

# 2. 尝试修复
sqlite3 data/kyxquota.db "PRAGMA integrity_check;"

# 3. 如果无法修复，恢复备份
rm data/kyxquota.db*
cp data.backup.20250122/kyxquota.db data/

# 4. 重启
docker-compose up -d
```

---

## 🔄 更新应用

### 更新代码

```bash
# 1. 停止服务
docker-compose down

# 2. 备份数据
cp -r data data.backup.$(date +%Y%m%d)

# 3. 拉取最新代码
git pull

# 4. 重新构建
docker-compose build --no-cache

# 5. 启动服务
docker-compose up -d

# 6. 验证
./verify.sh
```

---

## 📞 获取帮助

### 查看日志

```bash
# 容器日志
docker-compose logs -f app

# 数据库日志
docker-compose exec app sh -c "ls -lh data/"

# 系统日志
docker-compose logs
```

### 常见问题

1. **端口被占用** → 修改 `.env` 中的 `PORT`
2. **OAuth 失败** → 检查回调地址配置
3. **数据库锁定** → 删除 WAL 文件
4. **容器异常** → 查看 `docker-compose logs`

---

## 🎯 性能指标

部署后的预期性能：

| 指标 | 目标值 |
|------|--------|
| **QPS** | 70,000+ |
| **响应时间** | <5ms |
| **内存占用** | <50MB |
| **数据库大小** | <100MB（1万用户） |
| **启动时间** | <1秒 |

---

## ✅ 部署检查清单

部署前：
- [ ] Docker 已安装
- [ ] Docker Compose 已安装
- [ ] .env 文件已配置
- [ ] OAuth2 已申请
- [ ] 管理员密码已修改

部署后：
- [ ] 容器运行正常
- [ ] 用户端可访问
- [ ] 管理后台可访问
- [ ] OAuth 登录成功
- [ ] 数据库正常工作
- [ ] 缓存系统运行
- [ ] 日志输出正常

---

**部署完成！享受极致性能！** 🚀

