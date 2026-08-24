#!/bin/bash
#
# FlowHub - 一键启动本地管理台
# 双击此文件（或执行 ./start.command）即可：
#   1) 若 localhost:4173 尚未运行，则后台启动 node server.mjs
#   2) 等待服务就绪后，用默认浏览器打开 http://localhost:4173/
#
# 依赖：已安装 Node.js（node 命令可用）
#

# 让脚本在双击时能正确解析路径（macOS 双击时 cwd 可能不是脚本所在目录）
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4173}"
URL="http://localhost:${PORT}"

echo "== FlowHub 一键启动 =="
echo "服务端口: ${PORT}"
echo

# 1) 检查 node 是否可用
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node 命令。请先安装 Node.js：https://nodejs.org/"
  read -r -p "按回车关闭窗口…" _
  exit 1
fi

# 2) 检查端口是否已有服务在跑
is_running() {
  # 用 curl 探测，避免依赖 lsof/nc 的差异性
  curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -qE "200|301|302|304"
}

if is_running; then
  echo "[提示] 服务已在运行（${URL}），直接打开浏览器。"
else
  echo "[启动] 启动 node server.mjs ..."
  # 后台启动，日志写入 flowhub-server.log
  nohup node server.mjs > flowhub-server.log 2>&1 &
  SERVER_PID=$!
  echo "      已启动，PID=${SERVER_PID}（日志见 flowhub-server.log）"

  # 最多等 8 秒
  waited=0
  until is_running; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 8 ]; then
      echo "[错误] 服务启动超时。请检查 flowhub-server.log 与 ${PORT} 端口占用。"
      read -r -p "按回车关闭窗口…" _
      exit 1
    fi
  done
  echo "      服务就绪。"
fi

echo

# 3) 打开默认浏览器
echo "[打开] ${URL}"
open "${URL}" 2>/dev/null \
  || ( command -v xdg-open >/dev/null 2>&1 && xdg-open "${URL}" ) \
  || echo "[提示] 未能自动打开浏览器，请手动访问：${URL}"

echo
echo "完成。窗口可以关闭（服务在后台继续运行）。"
read -r -p "按回车关闭窗口…" _
