# 使用官方 Bun 镜像
FROM oven/bun:1.0.25-alpine

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package.json ./

# 安装依赖（不使用lockfile，全新安装）
RUN bun install --no-save --production

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

# 设置默认环境变量（容器内部配置）
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/kyxquota.db

# 启动应用
CMD ["bun", "src/index.ts"]

