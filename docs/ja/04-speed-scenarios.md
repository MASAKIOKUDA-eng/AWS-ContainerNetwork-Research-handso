# 04. スピードのシナリオ

[English](../en/04-speed-scenarios.md)

このハンズオンでの「スピード」には 3 つの意味があります。

1. **リクエストの遅延** — 経路が 1 リクエストにどれだけ時間を足すか（S-0、S-1、S-3）
2. **接続のコストとスループット** — 新しい接続や大きなオブジェクトにどれだけかかるか（S-2、S-4）
3. **つながるまでの時間** — 新しい利用者がサービスを呼べるようになるまでどれだけかかるか（S-6）

*CloudShell* と書いたもの以外は、負荷生成 EC2 で `lg` 関数経由で実行します（[03-handson-guide.md](03-handson-guide.md#26-負荷生成-ec2-に入る) を参照）。

## `run-k6.sh` が記録するメトリクス

| メトリクス | 意味 |
|------------|------|
| `total_p50_ms` / `total_p95_ms` / `total_p99_ms` | `http_req_duration`（送信〜最後のバイト）。計測フェーズのみ |
| `connect_p50_ms` / `connect_p99_ms` | TCP 接続の時間（接続を再利用していれば ≒ 0） |
| `tls_p50_ms` / `tls_p99_ms` | TLS ハンドシェイクの時間 |
| `wait_p50_ms` / `wait_p99_ms` | リクエスト送信後、最初のバイトまでの時間（サーバー + 経路） |
| `error_rate` | 期待したステータスでなかった応答の割合 |
| `throughput_MBps` | 計測フェーズで受信したバイト数 / 時間 |
| `dropped_iterations` | 0 より大きければ **負荷生成側** が限界。その回は捨てる |

## S-0 基準値：PrivateLink を通らない（*CloudShell*）

k6 を **提供側 VPC の中** の Fargate タスクとして動かし、NLB を直接呼びます。S-1（privatelink）− S-0 が PrivateLink のホップそのもののコストです。

```bash
./scripts/run-baseline.sh "100 500 1000" onlyIPv6
```

> 基準値のクライアントは Fargate、S-1 のクライアントは EC2 で、AZ の配置も違います。S-0 は桁を見るためのもので、正確な引き算ではありません。

## S-1 接続を再利用したときの遅延（メインの比較）

| ラベル | URL |
|--------|-----|
| `privatelink` | `http://$PL_DNS/1k` |
| `lattice-http` | `http://$LATTICE_DNS/1k` |
| `lattice-https` | `https://$LATTICE_DNS/1k` |
| `s3-gateway` | `https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k` |
| `s3-interface` | `https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1k` |

```bash
for i in 1 2 3; do
  lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"
  lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k"
  lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k"
done
lg run-k6.sh --label s3-gateway   --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k" --rates "100 500"
lg run-k6.sh --label s3-interface --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1k" --rates "100 500"
```

- 既定のレート：100 / 500 / 1000 rps、各 2 分（+ 20 秒のウォームアップ）。S3 は別種のサーバーなので、S3 の経路どうしでだけ比べる
- **仮説 H1**：PrivateLink ≒ 基準値 + 少し。Lattice HTTP はもう少し増える（L7 のプロキシ）。接続を再利用していれば HTTPS の上乗せは小さい
- p50 だけでなく **p99** を見る。100 rps で問題なくても 1000 rps で悪化することがある

## S-2 リクエストごとに新しい接続

```bash
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"       --reuse no --rates "100 300"
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k"  --reuse no --rates "100 300"
lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k" --reuse no --rates "100 300"
```

- `connect_*` と `tls_*` を S-1 と比べる
- **仮説 H3**：「接続を再利用しない HTTPS」のほうが「PrivateLink か Lattice か」よりコストが大きい。設計の教訓は経路ではなくコネクションプール

## S-3 同じ経路で IPv6 と IPv4

```bash
for ip in onlyIPv6 onlyIPv4; do
  lg run-k6.sh --label privatelink  --url "http://$PL_DNS/1k"      --ip "$ip" --rates "500"
  lg run-k6.sh --label lattice-http --url "http://$LATTICE_DNS/1k" --ip "$ip" --rates "500"
  lg run-k6.sh --label s3-gateway   --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k" --ip "$ip" --rates "500"
done
```

- **仮説 H2**：意味のある差はない。S3 ゲートウェイで IPv4 だけ（または IPv6 だけ）失敗する場合は `S3GatewayIpAddressType` を確認する
- Flow Logs でファミリーを確認する：`onlyIPv6` の回では、負荷生成 EC2 の ENI の `pkt-srcaddr` が IPv6 になっているはず

```
# /<prefix>/consumer/vpc-flow-logs に対する CloudWatch Logs Insights
parse @message "* * * * * * * * * * * * * * * * * * * *" as ver, eni, src, dst, sport, dport, proto, pkts, bytes, start, end, action, status, psrc, pdst, dir, path, az, ecssvc, ecstask
| filter dport in [80, 443] and dir = "egress"
| fields strcontains(psrc, ":") as is_ipv6
| stats sum(bytes) as total_bytes by is_ipv6, pdst, path
| sort total_bytes desc
```

## S-4 1 MiB のスループット

```bash
lg run-k6.sh --label privatelink  --url "http://$PL_DNS/1m"      --mode throughput --vus 32
lg run-k6.sh --label lattice-http --url "http://$LATTICE_DNS/1m" --mode throughput --vus 32
lg run-k6.sh --label s3-gateway   --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1m" --mode throughput --vus 32
lg run-k6.sh --label s3-interface --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1m" --mode throughput --vus 32
```

- MB/s が伸びなくなるまで `--vus` を上げる（32 → 64 → 128）。別のセッションで負荷生成 EC2 の CPU を見る（`top`）
- ① と ② の後ろは小さな Fargate タスク 2 つだけなので、**タスク** が限界になることがある。必要ならスタック 03 の `DesiredCount` / `TaskCpu` を上げ、記録しておく
- コストの面も忘れない：インターフェイスエンドポイントと Lattice は GB ごとに課金、S3 ゲートウェイエンドポイントは課金なし（料金ページで確認）

## S-5 スケール時のふるまい（任意）

`DesiredCount=4` で、p99 が悪化するまでレートを上げます（`--rates "1000 2000 4000"`）。経路ごとに、p99 が 100 rps のときの 2 倍になった最初のレートを記録します。

## S-6 新しい利用者がつながるまでの時間（*CloudShell*）

```bash
python3 scripts/measure-provisioning.py --prefix "$PREFIX" --csv results/provisioning.csv
cat results/provisioning.csv     # accept-endpoint.sh の accept_to_available も入っている
```

| 経路 | 新しい利用者チームがすること | 計測する時間 |
|------|------------------------------|--------------|
| PrivateLink | インターフェイスエンドポイントを作る → **提供側に承諾を依頼** → エンドポイントが available | 作成時間 + 人の待ち時間 + `accept_to_available` |
| VPC Lattice | VPC をサービスネットワークに関連付ける（ネットワークが共有されていれば） | 関連付けの作成時間 |
| S3 エンドポイント | ゲートウェイ：ルートテーブルの関連付け（無料）/ インターフェイス：AZ ごとのエンドポイント | 作成時間 |

- **仮説 H5**：サービスネットワークがあれば Lattice がいちばん早く使い始められる。PrivateLink は人の承認が入る（これはセキュリティ上の機能でもある）

## 結果の読み方

```bash
python3 scripts/summarize.py results/k6.csv --pivot total_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot total_p99_ms
python3 scripts/summarize.py results/k6.csv --pivot connect_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot tls_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot throughput_MBps
```

スライドに載せるときのルール：

- 3 回以上の中央値を示し、回数も書く
- 絶対値だけでなく **S-0 からの増分** を示す
- S3 の行とサービスの行は分ける
- 2 つの経路の差が、回ごとのばらつきより小さければ「意味のある差はない」と言う
