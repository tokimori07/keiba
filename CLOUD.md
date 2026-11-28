# 競馬ノートをクラウドで動かす（外出先・Macが止まっていても使う）

クラウド版は、インターネット上のサーバーで競馬ノートを24時間動かします。
iPhone・Mac・どの端末からでも同じ記録を使え、締切前のオッズの自動記録もMacを起動していなくても続きます。

- 費用: 月 約5ドル（Railway の Hobby プラン。利用料5ドル分込み）
- 接続: 合言葉入りのURLを開いた端末だけが使えます（URLは他の人に見せない）
- データ: 記録・保存ページ・学習結果はクラウドの永続ディスク（/data）に保存

## Railway での手順（おすすめ・約15分）

1. https://railway.com を開き、「Login」→「GitHub」でログインし、Hobby プランに登録（カード登録が必要）
2. 「New Project」→「Deploy from GitHub repo」→ `tokimori07/keiba` を選ぶ
   - 一覧に出ないときは「Configure GitHub App」でこのリポジトリへのアクセスを許可
3. できたサービスを開き、「Settings」→「Source」の Branch を `claude/cool-clarke-bs454c` にする
4. 「Variables」→「New Variable」で `KEIBA_KEY` = 自分で決めた合言葉（英数字で16文字以上。例: `uma-2026-xxxxxxxx`）
5. サービスを右クリック（または「+」）→「Volume」を追加し、Mount path を `/data` にする
6. 「Settings」→「Networking」→「Generate Domain」で URL（`https://〜.up.railway.app`）を作る
   - 「Settings」→「Region」は Asia（シンガポール）を選ぶと速い
7. ブラウザで `https://〜.up.railway.app/?key=合言葉` を開く → 競馬ノートが表示されれば完成
8. iPhone でも同じURLを開き、Safari の共有ボタン →「ホーム画面に追加」
   - 2台目以降は、クラウド版の「設定」→「iPhone・外出先で使う」のQRコードを読み取るだけ

## Macのデータをクラウドへ移す

1. Mac の競馬ノート（http://localhost:8765）の「設定」→「iPhone・外出先で使う」→「☁️ クラウド版へ移す」
2. クラウド版の「設定」に出ている URL（`?key=…` 付き）を貼り付けて「クラウドへ送る」
3. 馬券の記録・予想の振り返り・設定・学習結果が移ります（クラウド側の記録とはまとめられます）

移したあとは、Mac でもクラウドのURLを使えば、Mac版を止めても構いません（`bash uninstall-mac.command`）。

## 更新

GitHub のブランチに新しい版が入ると、クラウド版は自動で入れ替わります（アプリ内の更新ボタンは出ません）。

## Render を使う場合

「New」→「Blueprint」→ このリポジトリを選ぶと、`render.yaml` の設定（シンガポール・1GBの永続ディスク・合言葉の自動生成）で作られます。
合言葉は作成後に「Environment」の `KEIBA_KEY` で確認できます。費用は Starter（月7ドル）＋ディスク（月0.25ドル/GB）程度。

## 注意

- 取得元（netkeiba）がクラウドからのアクセスを制限した場合、オッズ取得が失敗することがあります。そのときは Mac 版に戻してください（記録はクラウドの「設定」→ JSON 書き出しで持ち出せます）。
- 合言葉を変えたいときは `KEIBA_KEY` を変更 → 全端末で新しいURLを開き直します。
