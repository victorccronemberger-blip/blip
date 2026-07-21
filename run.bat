@echo off
REM ============================================================
REM  MiMo-Code / PentesterCode  -  launcher (modo dev)
REM  Inicia o CLI a partir da raiz do projeto usando bun.
REM ============================================================

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo [ERRO] "bun" nao foi encontrado no PATH.
  echo Instale o Bun em https://bun.sh ou abra um terminal onde "bun --version" funcione.
  pause
  exit /b 1
)

echo Iniciando MiMo-Code (dev)...
bun run dev %*

REM Mantem a janela aberta se o app fechar/der erro
if errorlevel 1 pause
