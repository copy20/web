@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title FinStream 行情服务

set "PY="

rem 按顺序探测常见安装位置（每个都实际执行一次校验）
call :try "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
call :try "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
call :try "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
call :try "D:\Python\python.exe"
call :try "C:\Python312\python.exe"
call :try "C:\Python311\python.exe"

rem 退而使用 py 启动器
if not defined PY (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -c "import sys" >nul 2>nul
        if not errorlevel 1 set "PY=py"
    )
)

rem 最后使用 PATH 中的 python，跳过 Windows 应用商店的占位程序
if not defined PY (
    for /f "delims=" %%I in ('where python 2^>nul') do (
        echo %%I | findstr /I "WindowsApps" >nul
        if errorlevel 1 (
            "%%I" -c "import sys" >nul 2>nul
            if not errorlevel 1 if not defined PY set "PY=%%I"
        )
    )
)

if not defined PY (
    echo.
    echo [错误] 未找到可用的 Python 3。
    echo 请安装 Python 3.9 或更高版本：https://www.python.org/downloads/
    echo 安装时请勾选 "Add python.exe to PATH"。
    echo.
    pause
    exit /b 1
)

echo.
echo 解释器  : !PY!
echo 服务地址: http://127.0.0.1:8000
echo 停止服务: 按 Ctrl+C，或双击 stop.bat
echo.

"!PY!" server.py %*
set "CODE=%ERRORLEVEL%"

echo.
echo 服务已退出（退出码 %CODE%）。
pause
exit /b %CODE%

:try
if defined PY exit /b 0
if not exist "%~1" exit /b 0
"%~1" -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=%~1"
exit /b 0
