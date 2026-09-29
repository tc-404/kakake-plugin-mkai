@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
setlocal

echo.
echo ════════ 智能对话（MK_AI）构建打包 ════════
echo.

echo [1/2] 安装依赖...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/2] 构建 + 校验 + 打包 zip...
call npm run pack
if errorlevel 1 goto :fail

echo.
echo ✓ 全部完成。把上面列出的 zip 解压到 Kakake 插件目录即可安装。
echo.
pause
exit /b 0

:fail
echo.
echo ✗ 出错了（错误码 %errorlevel%），请看上面的日志。
echo.
pause
exit /b %errorlevel%
