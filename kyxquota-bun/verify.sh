#!/bin/bash

# KYX API Quota Bridge - 部署验证脚本

set -e

echo "🔍 KYX API Quota Bridge - 部署验证"
echo "=================================="

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 检查项计数
PASSED=0
FAILED=0

# 测试函数
test_check() {
    local name=$1
    local command=$2
    
    echo -n "检查 $name... "
    
    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 通过${NC}"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}✗ 失败${NC}"
        ((FAILED++))
        return 1
    fi
}

echo ""
echo "📦 1. 文件完整性检查"
echo "-------------------"

test_check "package.json" "[ -f package.json ]"
test_check "tsconfig.json" "[ -f tsconfig.json ]"
test_check "Dockerfile" "[ -f Dockerfile ]"
test_check "docker-compose.yml" "[ -f docker-compose.yml ]"
test_check "deploy.sh" "[ -f deploy.sh ]"
test_check ".env 文件" "[ -f .env ]"
test_check "src/index.ts" "[ -f src/index.ts ]"
test_check "src/config.ts" "[ -f src/config.ts ]"
test_check "src/database.ts" "[ -f src/database.ts ]"
test_check "src/cache.ts" "[ -f src/cache.ts ]"
test_check "src/routes/oauth.ts" "[ -f src/routes/oauth.ts ]"
test_check "src/routes/user.ts" "[ -f src/routes/user.ts ]"
test_check "src/routes/admin.ts" "[ -f src/routes/admin.ts ]"
test_check "src/templates/user.html" "[ -f src/templates/user.html ]"
test_check "src/templates/admin.html" "[ -f src/templates/admin.html ]"

echo ""
echo "🔧 2. 环境配置检查"
echo "-------------------"

if [ -f .env ]; then
    source .env
    
    test_check "LINUX_DO_CLIENT_ID" "[ ! -z \"$LINUX_DO_CLIENT_ID\" ]"
    test_check "LINUX_DO_CLIENT_SECRET" "[ ! -z \"$LINUX_DO_CLIENT_SECRET\" ]"
    test_check "LINUX_DO_REDIRECT_URI" "[ ! -z \"$LINUX_DO_REDIRECT_URI\" ]"
    test_check "ADMIN_PASSWORD" "[ ! -z \"$ADMIN_PASSWORD\" ]"
else
    echo -e "${RED}✗ .env 文件不存在${NC}"
    ((FAILED+=4))
fi

echo ""
echo "🐳 3. Docker 环境检查"
echo "-------------------"

test_check "Docker 已安装" "command -v docker"
test_check "Docker Compose 已安装" "command -v docker-compose"
test_check "Docker 服务运行中" "docker info"

echo ""
echo "📊 4. 容器状态检查"
echo "-------------------"

if docker-compose ps | grep -q "kyxquota-bun"; then
    test_check "容器运行中" "docker-compose ps | grep -q 'Up'"
    
    echo ""
    echo "🌐 5. 服务端点检查"
    echo "-------------------"
    
    PORT=${PORT:-3000}
    
    test_check "主页响应" "curl -f -s -o /dev/null http://localhost:$PORT/"
    test_check "管理后台响应" "curl -f -s -o /dev/null http://localhost:$PORT/admin"
    test_check "API 端点响应" "curl -f -s -o /dev/null http://localhost:$PORT/api/user/quota"
else
    echo -e "${YELLOW}⚠️  容器未运行，跳过服务端点检查${NC}"
    echo "   运行 'docker-compose up -d' 启动服务"
fi

echo ""
echo "=================================="
echo "📈 验证结果汇总"
echo "=================================="
echo -e "通过: ${GREEN}$PASSED${NC}"
echo -e "失败: ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ 所有检查通过！项目已准备就绪${NC}"
    echo ""
    echo "🚀 访问地址:"
    echo "   用户端: http://localhost:${PORT:-3000}"
    echo "   管理后台: http://localhost:${PORT:-3000}/admin"
    echo ""
    exit 0
else
    echo -e "${RED}❌ 有 $FAILED 项检查失败，请查看上方详情${NC}"
    echo ""
    echo "💡 常见解决方案:"
    echo "   1. 确保 .env 文件已正确配置"
    echo "   2. 运行 'docker-compose up -d' 启动服务"
    echo "   3. 检查 'docker-compose logs' 查看错误日志"
    echo ""
    exit 1
fi

