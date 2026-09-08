#!/usr/bin/env bash
#
# 服务器侧手工部署脚本（与 .github/workflows/deploy-h5.yml 内联逻辑等价）。
#
# 正常流程走 CI：push main → GitHub 构建 → scp → 自动替换。
# 本脚本用于 CI 挂了、或需要在服务器上直接重放某次产物的场景。
#
# 用法（在服务器上）：
#   # 产物已由 CI 传到 /tmp/jbs-h5-<run_id>
#   STAGING=/tmp/jbs-h5-123456 ./scripts/deploy-h5.sh
#
#   # 或本地构建后手工上传：
#   npm run build:h5 && scp -r dist/* jbs:/tmp/jbs-h5-manual/
#   ssh jbs "cd /opt/jbs && STAGING=/tmp/jbs-h5-manual bash -s" < scripts/deploy-h5.sh
#
# 环境变量：
#   APP_DIR  项目目录，默认 /opt/jbs
#   STAGING  暂存区目录（含 index.html / css / js / static），默认 /tmp/jbs-h5-new

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/jbs}"
STAGING="${STAGING:-/tmp/jbs-h5-new}"
FRONTEND_DIR="$APP_DIR/frontend"
BACKUP="$APP_DIR/frontend.bak.$(date +%Y%m%d-%H%M%S)"

rollback() {
  echo "!! 部署失败，回滚到备份"
  if [ -d "$BACKUP" ]; then
    rm -rf "$FRONTEND_DIR"
    mv "$BACKUP" "$FRONTEND_DIR"
    echo "已回滚到 $BACKUP"
  fi
  exit 1
}

# ---- 1. 暂存区自检 ----
if [ ! -f "$STAGING/index.html" ] || [ ! -d "$STAGING/js" ]; then
  echo "!! 暂存区不完整（缺 index.html 或 js/）：$STAGING"
  exit 1
fi

# ---- 2. 备份现有产物 ----
mkdir -p "$FRONTEND_DIR"
cp -a "$FRONTEND_DIR" "$BACKUP"
echo "已备份：$BACKUP"

# ---- 3. 替换（只动构建产物，保留 favicon 等非构建文件）----
rm -rf "$FRONTEND_DIR/css" "$FRONTEND_DIR/js" "$FRONTEND_DIR/static" "$FRONTEND_DIR/index.html"
cp -a "$STAGING/." "$FRONTEND_DIR/"
echo "已替换：$FRONTEND_DIR"

# ---- 4. 健康检查：文件 + HTTP ----
if [ ! -s "$FRONTEND_DIR/index.html" ] || ! grep -q 'id="app"' "$FRONTEND_DIR/index.html"; then
  echo "!! index.html 异常"
  rollback
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/ || echo "000")
if [ "$CODE" != "200" ]; then
  echo "!! HTTP 健康检查失败：$CODE"
  rollback
fi
echo "健康检查通过：HTTP $CODE"

# ---- 5. 清理：只保留最近 5 个备份 ----
if [ -z "${KEEP_STAGING:-}" ]; then rm -rf "$STAGING"; fi
ls -1dt "$APP_DIR"/frontend.bak.* 2>/dev/null | tail -n +6 | xargs -r rm -rf

echo "部署完成 ✅"
