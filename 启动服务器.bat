@echo off
chcp 65001 >nul
title 技能五子棋服务器

echo.
echo ╔════════════════════════════════════════╗
echo ║       ⚔️ 技能五子棋 服务器 ⚔️           ║
echo ╚════════════════════════════════════════╝
echo.
echo ⚠️  注意：如果手机无法连接，请尝试：
echo    1. 关闭 Windows 防火墙
echo    2. 或者使用路由器 WiFi 而非手机热点
echo.

node server.js

pause
