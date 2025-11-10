# 使用官方 Bun 镜像
FROM oven/bun:1.0.25-alpine

# 设置工作目录
WORKDIR /app

# 安装 curl（用于健康检查）
RUN apk add --no-cache curl

# 复制 package.json 和 bun.lockb
COPY package.json bun.lockb* ./

# 安装依赖（包括 ioredis）
RUN bun install

# 复制源代码
COPY src ./src
COPY tsconfig.json ./

# 复制老虎机符号图片（重要！）
COPY public ./public

# 复制工具脚本（虚拟币交易初始化工具）
COPY scripts ./scripts

# 创建必要的目录
RUN mkdir -p /app/data /app/logs

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

# 设置默认环境变量
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/kyxquota.db \
    REDIS_HOST=redis \
    REDIS_PORT=6379 \
    REDIS_PASSWORD=123456

# 启动应用
CMD ["bun", "src/index.ts"]