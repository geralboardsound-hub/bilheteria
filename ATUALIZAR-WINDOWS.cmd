@echo off
chcp 65001 >nul
title Bilheteria - Atualizar
cls
echo.
echo   ATUALIZAR A BILHETERIA
echo   ----------------------
echo.
echo   Publica as melhorias novas. Os eventos, reservas, contas e
echo   palavras-passe que ja tens ficam exatamente como estao.
echo.
pause
where node >nul 2>nul
if errorlevel 1 (
  echo   O Node.js nao esta instalado. Instala em https://nodejs.org (botao LTS)
  pause
  exit /b 1
)
node "%~dp0atualizar.mjs"
echo.
pause
