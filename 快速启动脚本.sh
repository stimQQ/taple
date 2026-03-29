#!/bin/bash

# Cap 一键部署脚本 - 国内服务器版
# 使用方法: bash 快速启动脚本.sh

set -e

echo "================================================"
echo "Cap 快速部署脚本"
echo "================================================"
echo ""

# 检查是否是 root
if [ "$EUID" -ne 0 ]; then
    echo "❌ 请使用 root 用户运行此脚本"
    echo "   sudo bash 快速启动脚本.sh"
    exit 1
fi

# 1. 检查 Docker
echo "1️⃣  检查 Docker..."
if ! command -v docker &> /dev/null; then
    echo "   Docker 未安装，正在安装..."
    curl -fsSL https://get.docker.com | sh
    systemctl start docker
    systemctl enable docker
    echo "   ✅ Docker 安装完成"
else
    echo "   ✅ Docker 已安装"
fi

# 2. 检查 Docker Compose
echo ""
echo "2️⃣  检查 Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
    echo "   Docker Compose 未安装，正在安装..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "   ✅ Docker Compose 安装完成"
else
    echo "   ✅ Docker Compose 已安装"
fi

# 3. 创建部署目录
echo ""
echo "3️⃣  创建部署目录..."
DEPLOY_DIR="/opt/cap"
mkdir -p $DEPLOY_DIR
cd $DEPLOY_DIR
echo "   ✅ 部署目录: $DEPLOY_DIR"

# 4. 获取服务器 IP
echo ""
echo "4️⃣  检测服务器信息..."
SERVER_IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip || echo "未检测到")
echo "   服务器公网 IP: $SERVER_IP"

# 5. 生成随机密钥
echo ""
echo "5️⃣  生成安全密钥..."
DB_ENCRYPTION_KEY=$(openssl rand -hex 32)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
MYSQL_PASSWORD=$(openssl rand -hex 16)
MINIO_PASSWORD=$(openssl rand -hex 16)

echo "   ✅ 密钥已生成"

# 6. 询问域名
echo ""
echo "6️⃣  配置访问地址..."
read -p "   是否有域名？(y/n) [默认 n]: " HAS_DOMAIN
HAS_DOMAIN=${HAS_DOMAIN:-n}

if [[ $HAS_DOMAIN == "y" ]]; then
    read -p "   请输入你的域名（如 cap.example.com）: " DOMAIN
    WEB_URL="https://$DOMAIN"
    S3_PUBLIC_ENDPOINT="https://$DOMAIN:9000"
else
    DOMAIN=$SERVER_IP
    WEB_URL="http://$SERVER_IP:3000"
    S3_PUBLIC_ENDPOINT="http://$SERVER_IP:9000"
fi

echo "   访问地址: $WEB_URL"
echo "   存储地址: $S3_PUBLIC_ENDPOINT"

# 7. 创建 docker-compose.yml
echo ""
echo "7️⃣  创建配置文件..."

cat > docker-compose.yml <<EOF
name: cap-deployment

services:
  cap-web:
    container_name: cap-web
    image: ghcr.io/capsoftware/cap-web:latest
    restart: unless-stopped
    depends_on:
      mysql:
        condition: service_healthy
      minio:
        condition: service_healthy
    environment:
      # 基础配置
      DATABASE_URL: 'mysql://root:${MYSQL_PASSWORD}@mysql:3306/cap?ssl={"rejectUnauthorized":false}'
      WEB_URL: ${WEB_URL}
      NEXTAUTH_URL: ${WEB_URL}

      # 安全密钥
      DATABASE_ENCRYPTION_KEY: ${DB_ENCRYPTION_KEY}
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}

      # MinIO 存储
      CAP_AWS_ACCESS_KEY: cap-admin
      CAP_AWS_SECRET_KEY: ${MINIO_PASSWORD}
      CAP_AWS_BUCKET: cap-videos
      CAP_AWS_REGION: us-east-1
      S3_INTERNAL_ENDPOINT: http://minio:9000
      S3_PUBLIC_ENDPOINT: ${S3_PUBLIC_ENDPOINT}

    ports:
      - "3000:3000"
    networks:
      - cap-network

  mysql:
    container_name: cap-mysql
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_DATABASE: cap
      MYSQL_ROOT_HOST: "%"
    command:
      - --default-authentication-plugin=mysql_native_password
      - --max_connections=1000
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    ports:
      - "3306:3306"
    volumes:
      - mysql-data:/var/lib/mysql
    networks:
      - cap-network
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p${MYSQL_PASSWORD}"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    container_name: cap-minio
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: cap-admin
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data
    networks:
      - cap-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

volumes:
  mysql-data:
  minio-data:

networks:
  cap-network:
    driver: bridge
EOF

echo "   ✅ 配置文件已创建"

# 8. 保存密码信息
cat > .credentials <<EOF
# Cap 部署凭证信息
# 请妥善保管此文件！

部署时间: $(date)
服务器 IP: $SERVER_IP
访问地址: $WEB_URL

# MySQL 数据库
MySQL Root 密码: ${MYSQL_PASSWORD}

# MinIO 存储
MinIO 用户名: cap-admin
MinIO 密码: ${MINIO_PASSWORD}
MinIO 控制台: http://$SERVER_IP:9001

# 安全密钥（请勿泄露）
DATABASE_ENCRYPTION_KEY: ${DB_ENCRYPTION_KEY}
NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
EOF

chmod 600 .credentials

echo "   ✅ 凭证已保存到 .credentials"

# 9. 配置防火墙
echo ""
echo "8️⃣  配置防火墙..."

if command -v ufw &> /dev/null; then
    ufw allow 3000/tcp
    ufw allow 9000/tcp
    ufw allow 9001/tcp
    echo "   ✅ UFW 防火墙规则已添加"
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=3000/tcp
    firewall-cmd --permanent --add-port=9000/tcp
    firewall-cmd --permanent --add-port=9001/tcp
    firewall-cmd --reload
    echo "   ✅ FirewallD 规则已添加"
else
    echo "   ⚠️  未检测到防火墙，请手动开放端口: 3000, 9000, 9001"
fi

# 10. 启动服务
echo ""
echo "9️⃣  启动服务..."
echo "   正在拉取镜像（首次可能需要几分钟）..."

docker-compose pull

echo "   启动容器..."
docker-compose up -d

echo "   ✅ 服务已启动"

# 11. 等待服务就绪
echo ""
echo "🔟 等待服务启动完成..."
sleep 10

# 检查容器状态
echo "   检查容器状态..."
docker-compose ps

# 12. 配置 MinIO 存储桶
echo ""
echo "1️⃣1️⃣  配置 MinIO 存储桶..."
sleep 5

docker exec cap-minio sh -c "
    mc alias set myminio http://localhost:9000 cap-admin ${MINIO_PASSWORD} && \
    mc mb myminio/cap-videos 2>/dev/null || true && \
    mc anonymous set download myminio/cap-videos
" && echo "   ✅ MinIO 存储桶已配置" || echo "   ⚠️  MinIO 配置失败，请手动配置"

# 13. 完成提示
echo ""
echo "================================================"
echo "🎉 部署完成！"
echo "================================================"
echo ""
echo "📌 访问信息："
echo "   Cap Web:         $WEB_URL"
echo "   MinIO 控制台:    http://$SERVER_IP:9001"
echo ""
echo "📌 登录凭证（保存在 $DEPLOY_DIR/.credentials）："
echo "   MinIO 用户名:    cap-admin"
echo "   MinIO 密码:      ${MINIO_PASSWORD}"
echo ""
echo "📌 查看运行状态："
echo "   cd $DEPLOY_DIR"
echo "   docker-compose ps"
echo "   docker-compose logs -f cap-web"
echo ""
echo "📌 获取登录链接："
echo "   docker-compose logs cap-web | grep 'http'"
echo ""

if [[ $HAS_DOMAIN == "y" ]]; then
    echo "⚠️  下一步："
    echo "   1. 配置域名 DNS 解析到: $SERVER_IP"
    echo "   2. 配置 Nginx 反向代理"
    echo "   3. 配置 HTTPS 证书（推荐使用 Let's Encrypt）"
    echo ""
    echo "   详细步骤参考: $DEPLOY_DIR/国内部署指南.md"
else
    echo "✅ 现在可以访问："
    echo "   $WEB_URL"
    echo ""
    echo "⚠️  注意："
    echo "   - 使用 IP 访问仅适合测试"
    echo "   - 生产环境建议配置域名和 HTTPS"
fi

echo ""
echo "📚 完整文档："
echo "   $DEPLOY_DIR/国内部署指南.md"
echo ""
echo "================================================"
