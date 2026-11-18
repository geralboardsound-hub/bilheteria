@echo off
chcp 65001 >nul
title Bilheteria - Diagnostico
cls
echo.
echo   DIAGNOSTICO DA BILHETERIA
echo   Verifica conta, base de dados, contas de equipa e testa o login.
echo.
pause
where node >nul 2>nul
if errorlevel 1 (
  echo   Instala primeiro o Node.js: https://nodejs.org  (botao LTS)
  pause
  exit /b 1
)
node "%~dp0diagnostico.mjs"
echo.
pause
