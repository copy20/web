@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

echo.
echo 正在查找监听端口 %PORT% 的进程…
echo.

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr /C:"LISTENING"') do (
    if not defined SEEN_%%P (
        set "SEEN_%%P=1"
        set "FOUND=1"
        echo 结束进程 PID=%%P
        taskkill /F /PID %%P >nul 2>nul
        if errorlevel 1 (
            echo   失败：权限不足，请右键以管理员身份运行本脚本。
        ) else (
            echo   已结束。
        )
    )
)

if "!FOUND!"=="0" (
    echo 未发现监听 %PORT% 端口的服务，可能已经停止。
) else (
    echo.
    echo 服务已停止，端口 %PORT% 已释放。
)

echo.
echo 按任意键关闭窗口。
pause >nul
