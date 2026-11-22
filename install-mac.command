#!/bin/bash
# 競馬ノートを「Macにログインしたら自動で起動」する設定をします。
# ダブルクリックで実行。以後はブラウザで http://localhost:8765 を開くだけで使えます。
# 新しいバージョンをダウンロードしたときも、そのフォルダのこのファイルを実行すれば更新されます。
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/KeibaNote"            # 「ダウンロード」フォルダはMacの保護で自動起動から読めないため、ここに置く
LABEL="com.keiba-note.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/keiba-note.log"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 が見つかりません。ターミナルで python3 と打ち、表示に従ってインストールしてから再実行してください。"
  read -r -p "Enterキーで閉じます"; exit 1
fi

echo "1/3 アプリを $DEST にコピー中…"
mkdir -p "$DEST"
cp -R "$SRC/index.html" "$SRC/server.py" "$SRC/analysis.py" "$SRC/backtest.py" "$SRC/learn.py" "$SRC/css" "$SRC/js" "$DEST/"

echo "2/3 自動起動を設定中…"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$DEST/server.py</string>
    <string>--no-browser</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "3/3 起動を確認中…"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -m 1 http://localhost:8765/api/ping >/dev/null 2>&1; then
    open "http://localhost:8765"
    echo ""
    echo "完了しました。今後は http://localhost:8765 をブックマークして開くだけでOKです。"
    echo "（Macを再起動しても自動で起動します。このウィンドウは閉じて構いません）"
    exit 0
  fi
  sleep 1
done
echo "起動を確認できませんでした。ログ: $LOG"
tail -n 20 "$LOG" 2>/dev/null || true
read -r -p "Enterキーで閉じます"
