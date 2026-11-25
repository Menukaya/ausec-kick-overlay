@echo off
chcp 65001 >nul
title AUSEC Kick Yayin Servisi
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js kurulu degil!
  echo https://nodejs.org adresinden LTS surumunu indirip kurun.
  pause
  exit /b 1
)

if not exist node_modules\ws (
  echo Gerekli paketler kuruluyor, lutfen bekleyin...
  call npm install ws --no-audit --no-fund
)

:baslat
cls
node ausec-servis.js
if errorlevel 42 (
  echo.
  echo Guncelleme uygulandi, servis yeniden baslatiliyor...
  timeout /t 2 /nobreak >nul
  goto baslat
)
pause