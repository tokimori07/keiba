#!/bin/bash
# Mac: このファイルをダブルクリックすると競馬ノートが起動します
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "Python が見つかりません。https://www.python.org/downloads/ からインストールしてください。"
  read -r -p "Enterキーで閉じます"; exit 1
fi
"$PY" server.py "$@"
status=$?
if [ $status -ne 0 ]; then read -r -p "エラーで終了しました（上のメッセージを確認）。Enterキーで閉じます"; fi
