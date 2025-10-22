#!/bin/bash

# KYX API Quota Bridge - 快速部署脚本
# 适用于 Docker 环境

set -e

echo "🚀 KYX API Quota Bridge - 部署脚本"
echo "=================================="

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker 未安装，请先安装 Docker${NC}"
    echo "安装指南: https://docs.docker.com/get-docker/"
    exit 1
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose 未安装，请先安装 Docker Compose${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Docker 环境检查通过${NC}"

# 创建必要的目录
echo "📁 创建数据目录..."
mkdir -p data logs
chmod 755 data logs

# 检查 .env 文件
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  未找到 .env 文件${NC}"
    echo "正在从模板创建..."
    cp env.example .env
    
    echo -e "${YELLOW}请编辑 .env 文件，配置以下必要参数:${NC}"
    echo "  - LINUX_DO_CLIENT_ID"
    echo "  - LINUX_DO_CLIENT_SECRET"
    echo "  - LINUX_DO_REDIRECT_URI"
    echo "  - ADMIN_PASSWORD"
    echo ""
    read -p "是否现在编辑 .env 文件? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ${EDITOR:-nano} .env
    else
        echo -e "${RED}请手动编辑 .env 文件后重新运行此脚本${NC}"
        exit 1
    fi
fi

# 验证环境变量
source .env

if [ -z "$LINUX_DO_CLIENT_ID" ] || [ -z "$LINUX_DO_CLIENT_SECRET" ] || [ -z "$LINUX_DO_REDIRECT_URI" ]; then
    echo -e "${RED}❌ 缺少必要的环境变量，请检查 .env 文件${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 环境配置检查通过${NC}"

# 拉取镜像
echo "📥 拉取 Docker 镜像..."
docker-compose pull

# 启动服务
echo "🚀 启动服务..."
docker-compose up -d

# 等待服务启动
echo "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
if docker-compose ps | grep -q "Up"; then
    echo -e "${GREEN}✅ 服务启动成功！${NC}"
    echo ""
    echo "=================================="
    echo "📍 访问地址:"
    echo "   用户端: http://localhost:${PORT:-3000}"
    echo "   管理后台: http://localhost:${PORT:-3000}/admin"
    echo ""
    echo "📊 查看日志: docker-compose logs -f"
    echo "🛑 停止服务: docker-compose down"
    echo "🔄 重启服务: docker-compose restart"
    echo "=================================="
else
    echo -e "${RED}❌ 服务启动失败，请查看日志${NC}"
    docker-compose logs
    exit 1
fi

