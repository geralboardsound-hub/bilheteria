@echo off
chcp 65001 >nul
title Bilheteria - Trocar de conta Cloudflare
cls
echo.
echo   TROCAR DE CONTA CLOUDFLARE
echo   --------------------------
echo.
echo   Desliga o wrangler da conta antiga e liga-o a conta nova.
echo   Nao apaga nada da aplicacao nem da base de dados.
echo.
pause
where node >nul 2>nul
if errorlevel 1 (
  echo   Instala primeiro o Node.js: https://nodejs.org  (botao LTS)
  pause
  exit /b 1
)
node "%~dp0trocar-conta.mjs"
echo.
pause
