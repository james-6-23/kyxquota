# 使用官方 Bun 镜像
FROM oven/bun:1.0.25-alpine as base

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package.json bun.lockb* ./

# 安装依赖
RUN bun install --frozen-lockfile --production

# 复制源代码
COPY src ./src
COPY tsconfig.json ./

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

# 设置环境变量
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/kyxquota.db

# 启动应用
CMD ["bun", "src/index.ts"]

