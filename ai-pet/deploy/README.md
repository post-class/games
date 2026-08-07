# デプロイ手順（ADR-006: 単一VPS ＋ systemd ＋ Nginx）

『ぽこもふ島』は**サーバが常に動いていて島の時間が進んでいる**ことが前提のゲームなので、
コールドスタートや実行時間制限のあるサーバレスとは相性が悪い。1台のLinuxホストで常駐させる。

```
[ブラウザ] --https--> [Nginx] --+--> /            静的ファイル（Viteのビルド成果物）
                                +--> /ws          WebSocket（ポート8787へプロキシ）
                                +--> /healthz     死活監視
                                       |
                                 [systemd: pokomofu.service]
                                   node packages/server/src/main.ts
                                       |
                                 data/island.db（SQLite + WAL）
```

## 1. 前提

- Ubuntu 24.04 以上（Node 24 が入ること）
- Node 24 系（`node --experimental-strip-types` 相当の型ストリップが既定で有効なバージョン）
- ドメインとDNSのAレコード
- ポート 80 / 443 が開いていること（8787 は**外に開けない**。Nginx経由のみ）

```bash
# Node 24（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx build-essential
```

`build-essential` は `better-sqlite3` のネイティブビルドに必要。

## 2. 配置

```bash
sudo useradd -r -m -d /srv/pokomofu -s /usr/sbin/nologin pokomofu
sudo -u pokomofu git clone <repo> /srv/pokomofu/app
cd /srv/pokomofu/app/ai-pet
sudo -u pokomofu npm ci
sudo -u pokomofu npm run build          # クライアントを dist/ に出す
sudo -u pokomofu mkdir -p /srv/pokomofu/app/ai-pet/data
```

## 3. 環境変数

`/srv/pokomofu/app/.env`（**このファイルだけ 600 にする**。APIキーが入る）

```
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2025-04-01-preview
LLM_MODEL_PET=gpt-5.6-luna

PORT=8787
NODE_ENV=production
ISLAND_SEED=pokomofu-2
DB_PATH=/srv/pokomofu/app/ai-pet/data/island.db
LLM_MAX_RPH_PER_PLAYER=40
```

```bash
sudo chown pokomofu:pokomofu /srv/pokomofu/app/.env
sudo chmod 600 /srv/pokomofu/app/.env
```

`NODE_ENV=production` にすると `/metrics` が無効になる（内部情報を外に出さない）。

## 4. systemd

`deploy/pokomofu.service` を `/etc/systemd/system/` に置く。

```bash
sudo cp deploy/pokomofu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pokomofu
sudo systemctl status pokomofu
journalctl -u pokomofu -f
```

**停止時に島が保存される**（SIGTERM → スナップショット保存 → WALチェックポイント）。
`TimeoutStopSec=20` を確保しているので、`systemctl restart` で島が壊れない。

## 5. Nginx

`deploy/nginx.conf` を参考に `/etc/nginx/sites-available/pokomofu` を作る。

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pokomofu
sudo ln -s /etc/nginx/sites-available/pokomofu /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <domain>        # TLS（証明書の自動更新まで面倒を見てくれる）
```

WebSocket は `proxy_read_timeout` を長くしないと**無通信で切られる**。
このゲームは4Hzで delta が流れるので実際には切れないが、余裕を持って 300s にしてある。

## 6. バックアップ

`deploy/backup.sh` を日次で回す（SQLiteのオンラインバックアップAPIを使うので停止不要）。

```bash
sudo cp deploy/backup.sh /usr/local/bin/pokomofu-backup
sudo chmod +x /usr/local/bin/pokomofu-backup
# 毎日 4:17 に（正時を避ける）
echo "17 4 * * * pokomofu /usr/local/bin/pokomofu-backup" | sudo tee /etc/cron.d/pokomofu-backup
```

## 7. 監視

```bash
# 死活
curl -fsS https://<domain>/healthz
# → {"ok":true,"v":1,"tick":123456,"clients":2}
```

- `tick` が増えていなければシミュレーションが止まっている（プロセスは生きていても異常）
- systemd の `Restart=always` で落ちても復帰する。**復帰時は停止していた時間ぶん島時間を早送りする**
- LLMのコストは開発時のみ `/metrics` の `llm.usage1h` で見る。本番では `llm_usage` テーブルを直接読む:
  ```sql
  SELECT purpose, COUNT(*), SUM(prompt_tokens), SUM(completion_tokens)
  FROM llm_usage WHERE ts > (unixepoch()*1000 - 3600000) GROUP BY purpose;
  ```

## 8. 更新（デプロイ）

```bash
cd /srv/pokomofu/app && sudo -u pokomofu git pull
cd ai-pet && sudo -u pokomofu npm ci && sudo -u pokomofu npm run build
sudo systemctl restart pokomofu        # 島は保存され、再開時に時間が進む
```

**seedを変えても既存の島は変わらない**（DBのseedが優先される）。島を作り直したいときは
`data/island.db` を退避してから起動する。

## 9. 既知の制約

- 1プロセス＝1島。同時16人を超えたら島インスタンスを増やす想定（ロビーは未実装）
- スケールアウトは手動。プロセスを増やす場合はポートと `DB_PATH` を分ける
- `/metrics` は `NODE_ENV=production` で無効。必要なときだけ一時的に外す
