#!/bin/bash
# 競馬ノートの自動起動を解除します（記録データはブラウザ内に残ります）
LABEL="com.keiba-note.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "自動起動を解除しました。アプリ本体（~/KeibaNote）は残しています。不要ならFinderで削除してください。"
read -r -p "Enterキーで閉じます"
