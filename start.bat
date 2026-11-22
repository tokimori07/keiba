@echo off
rem Windows: このファイルをダブルクリックすると競馬ノートが起動します
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
where py >nul 2>nul && (py -3 server.py %* & goto end)
where python >nul 2>nul && (python server.py %* & goto end)
echo Python が見つかりません。https://www.python.org/downloads/ からインストールしてください（インストール時に "Add python.exe to PATH" にチェック）。
:end
pause
