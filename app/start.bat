@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 初回セットアップ中です。数分かかります...
  call npm install
)
call npm start
