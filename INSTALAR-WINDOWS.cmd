@echo off
chcp 65001 >nul
title Bilheteria - Instalacao
cls
echo.
echo   BILHETERIA - INSTALACAO
echo   -----------------------
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   O Node.js nao esta instalado.
  echo   Vou abrir a pagina de descarregamento no navegador.
  echo   Carrega no botao verde LTS, instala e volta a correr este ficheiro.
  start "" https://nodejs.org/pt-br/download
  pause
  exit /b 1
)
node "%~dp0instalar.mjs"
echo.
pause
