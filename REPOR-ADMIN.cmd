@echo off
chcp 65001 >nul
title Bilheteria - Repor administrador
cls
echo.
echo   REPOR A CONTA DE ADMINISTRADOR
echo.
echo     E-mail:        geral.boardsound@gmail.com
echo     Palavra-passe: @Angola123
echo.
pause
where node >nul 2>nul
if errorlevel 1 (
  echo   Instala primeiro o Node.js: https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0semente.mjs"
echo.
pause
