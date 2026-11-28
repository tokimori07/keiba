# 競馬ノート クラウド版（Railway / Render / Fly.io などで動かす）
FROM python:3.12-slim
WORKDIR /app
COPY index.html server.py analysis.py backtest.py learn.py ./
COPY css ./css
COPY js ./js
# 日本時間で動かす（開催日の判定・オッズの自動記録の時間帯のため）
ENV TZ=JST-9 \
    KEIBA_CLOUD=1 \
    KEIBA_DATA_DIR=/data \
    PYTHONUNBUFFERED=1
# /data に永続ディスク（ボリューム）をつなぐ。記録・保存ページ・学習結果はここに残る
CMD ["sh", "-c", "mkdir -p /data && exec python server.py --no-browser --port ${PORT:-8765}"]
