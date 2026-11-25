@echo off
chcp 65001 >nul
title AUSEC Yayin Paketi Guncelleyici
cd /d "%~dp0"
node ausec-servis.js --guncelle
echo.
pause