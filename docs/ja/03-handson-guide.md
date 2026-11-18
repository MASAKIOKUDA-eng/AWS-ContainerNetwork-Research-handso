# 03. ハンズオンガイド：IPv6 前提のコンテナネットワーク — PrivateLink / VPC エンドポイント / VPC Lattice の比較

[English](../en/03-handson-guide.md)

> 料金とサービス仕様は変わります。実施する日に [references.md](references.md) の公式ドキュメントで確認してください。
> 本文の「仮説」は計測前の予想であり、結果ではありません。

## 目次

- [0. 公平に比べるためのルール](#0-公平に比べるためのルール)
- [1. 事前準備](#1-事前準備)
- [2. 環境構築](#2-環境構築)
- [3. スピードのシナリオ](#3-スピードのシナリオ)
- [4. セキュリティのシナリオ](#4-セキュリティのシナリオ)
- [5. 任意：IPv6 のみのワークロード](#5-任意ipv6-のみのワークロード)
- [6. 後片付け](#6-後片付け)
- [付録A. セキュリティチェックリスト](#付録a-セキュリティチェックリスト)
- [付録B. トラブルシューティング](#付録b-トラブルシューティング)

構成と設計の理由は [02-architecture.md](02-architecture.md) にあります。

---

## 0. 公平に比べるためのルール

- `svc-pl` と `svc-lattice` は、イメージ、タスクサイズ（0.5 vCPU / 1 GiB）、タスク数（2）、サブネットを同じにする
- 負荷生成、k6 スクリプト、**かける負荷**（一定の到着レート）は全経路で同じ
- 計測の既定のアドレスファミリーは **IPv6 のみ**（`--ip onlyIPv6`）。IPv4 は S-3 で別に測る
- 各計測は **最低 3 回**（スライドに載せる数字は 5 回）繰り返し、中央値を使う
- 日時、リージョン、負荷生成とタスクの AZ、インスタンスタイプ、イメージのタグ、cdkd のバージョンを記録する
- 繰り返すたびに経路の **順番を変える**（「最初の回だけ遅い」の偏りを避ける）

## 1. 事前準備

### 1.1 必要なもの

| 項目 | 内容 |
|------|------|
| AWS アカウント | **検証専用アカウント** |
| 実行環境 | **AWS CloudShell を推奨**（手元に長期のアクセスキーを置かずに済む。bash、AWS CLI v2、jq、Docker、Python 3、Node.js がある。cdkd には Node.js **22.12 以上** が必要） |
| リージョン | 例：`ap-northeast-1`。VPC Lattice、ECR / Logs / SSM のデュアルスタックのエンドポイント、S3 ゲートウェイエンドポイントの IPv6 が使えることを確認する |
| 権限 | IAM ロール、VPC、ECS、ELB、VPC Lattice、S3、EC2 のリソースを直接作れる権限（cdkd は CloudFormation ではなく各サービスの API を呼ぶ）。検証後に外す |
| コスト | 起動中は 1 時間あたり数 USD 程度（インターフェイスエンドポイント × AZ × 2 VPC、NLB、Fargate、Lattice、EC2）。**その日のうちに削除する** |

### 1.2 コードの取得

```bash
export AWS_REGION=ap-northeast-1
export PREFIX=v6lab            # 変える場合は cdk.json のコンテキスト "prefix" と合わせる
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
git clone https://github.com/MASAKIOKUDA-eng/AWS-ContainerNetwork-Research-handso.git
cd AWS-ContainerNetwork-Research-handso
npm ci
npm test        # 合成したテンプレートでセキュリティ / IPv6 の要件を確認（AWS は呼ばない）
```

> スクリプトは `PREFIX=v6lab` のような名前（英小文字・数字・`-` で 3〜16 文字）を前提にしています。

### 1.3 予算アラート

```bash
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"'"$PREFIX"'","BudgetLimit":{"Amount":"30","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<your-mail>"}]}]'
```

すべてのリソースに `Project=<prefix>` タグが付きます。Cost Explorer でハンズオン分を集計したい場合は、コスト配分タグとして有効化してください。

### 1.4 イメージスキャンを有効にする（アカウント / リージョンごとに 1 回）

cdkd は 2 つのイメージをビルドし、cdkd 用の ECR リポジトリに push します。レジストリ全体で push 時にスキャンします。

```bash
aws ecr put-registry-scanning-configuration --scan-type BASIC \
  --rules '[{"scanFrequency":"SCAN_ON_PUSH","repositoryFilters":[{"filter":"*","filterType":"WILDCARD"}]}]'
```

---

## 2. 環境構築

インフラは CDK アプリ（`bin/app.ts`、`lib/*.ts`）で、**cdkd** でデプロイします。CloudFormation のスタックは作らず、AWS SDK を直接呼び出します。
同じアプリは AWS CDK CLI でもデプロイできます（`npm run cdk:deploy`、`cdk bootstrap` が必要）。

### 2.1 ブートストラップと確認

```bash
npx cdkd bootstrap     # アカウント / リージョンごとに 1 回：cdkd の状態用バケット + アセット用バケット + コンテナアセット用 ECR
npm run synth          # cdk.out/ にテンプレートを出力（設計資料としても使える）
npm run diff           # 作られるものを確認
```

設定は CDK の **コンテキスト** です（既定値は `cdk.json`、`-c key=value` で上書き）。不正な値は synth の時点でエラーになります。

| コンテキスト | 既定値 | 意味 |
|--------------|--------|------|
| `prefix` | `v6lab` | スタック / リソース名の接頭辞 |
| `workloadIpMode` | `dualstack` | `ipv6only` = ワークロードのサブネットを IPv6 のみにする（5.） |
| `latticeAuthMode` | `vpc-only` | `iam-required` = 自アカウントの SigV4 署名付きの呼び出しのみ許可（X-3） |
| `endpointIpAddressType` / `s3GatewayIpAddressType` | `dualstack` | `ipv4` = IPv6 未対応リージョン向けの代替 |
| `nlbEnforceSgOnPrivateLink` | `off` | PrivateLink の通信に NLB の SG を適用するか |
| `desiredCount` / `taskCpu` / `taskMemory` | `2` / `512` / `1024` | `svc-pl` と `svc-lattice` の大きさ |
| `cpuArchitecture` | `X86_64` | `ARM64` にすると arm64 のイメージをビルドし、Graviton の Fargate を使う |
| `loadgenInstanceType` | `c7i.xlarge` | Nitro のタイプ（IPv6 のみのサブネットでは必須） |

### 2.2 デプロイ

```bash
npm run deploy
```

`scripts/deploy.sh` は `cdkd deploy --all --outputs-file cdk-outputs.json` を実行し、`deploy-logs/` にログ（アカウント ID は伏せ字）を残し、所要時間を `deploy-logs/HISTORY.md` に 1 行追記します。ほかのスクリプトは `cdk-outputs.json` から値を読みます（手元だけに置く。`.gitignore` 済み）。

4 つのスタック（依存関係の順）：

| スタック | 主なリソース | ポイント |
|----------|--------------|----------|
| `v6lab-consumer-vpc` / `v6lab-provider-vpc` | VPC `10.0.0.0/16`（**両方とも**）+ Amazon 提供の IPv6 /56 | IPv4 はわざと重複（X-6） |
| | エッジ サブネット × 2（デュアルスタック）/ ワークロード サブネット × 2（`workloadIpMode`） | エッジに NLB とエンドポイント、ワークロード層にタスクと負荷生成 EC2 |
| | ローカルルートだけのルートテーブル | IGW / NAT / EIGW なし。検証対象の経路以外では外に出られない |
| | デュアルスタックのインターフェイスエンドポイント ECR API / ECR DKR / Logs（利用側は SSM × 3 も） | IPv6 のみのタスクでもイメージ取得とログ送信ができる |
| | S3 ゲートウェイエンドポイント（`IpAddressType: dualstack`） | **エンドポイントポリシー**：ECR のレイヤー用バケット、AL2023 のリポジトリ、（利用側は）データ用バケットだけ |
| | Flow Logs | `pkt-srcaddr`、`pkt-dstaddr`、`flow-direction`、`traffic-path` を含むカスタム形式 |
| `v6lab-provider` | イメージ `docker/netbench`、`docker/loadgen`（cdkd がビルド、タグは内容のハッシュ） | 手作業のビルド / push / ダイジェストの受け渡しは不要 |
| | ECS クラスター（Container Insights 強化版）、タスク実行ロール、**権限のない** タスクロール | |
| | 内部 NLB `IpAddressType: dualstack` + TCP 80 → ターゲットグループ（ip、8080） | ファミリーはデュアルスタックでは IPv4、IPv6 のみでは IPv6 |
| | VPC エンドポイントサービス | `AcceptanceRequired: true`、`SupportedIpAddressTypes: [ipv4, ipv6]`、許可するプリンシパルは自アカウントのみ |
| | Lattice のサービスネットワーク + サービス（`AWS_IAM`）、HTTP 80 / HTTPS 443、IP ターゲットグループ | 認証ポリシー：**利用側 VPC からのみ**。サービスのポリシーは `latticeAuthMode` で切り替え |
| | Lattice のアクセスログ → CloudWatch Logs | 認証の判断、呼び出し元のプリンシパル、送信元 VPC、ターゲットのアドレス |
| | `svc-pl`（NLB のターゲットグループ）/ `svc-lattice`（`VpcLatticeConfigurations`、ポート名 `http`）、基準値用のタスク定義 | 両経路の後ろは同じタスク定義 |
| `v6lab-consumer` | 負荷生成 EC2（SSM のみ）、信頼する / 信頼しないクライアント SG | |
| | PrivateLink のインターフェイスエンドポイント（デュアルスタック） | 提供側が承諾するまで `pendingAcceptance`（2.3） |
| | Lattice サービスネットワークの VPC 関連付け（SG 付き） | |
| | S3 のデータ用 / 外部バケット、S3 インターフェイスエンドポイント（デュアルスタック、エンドポイントポリシー） | 読み取りは `aws:SourceVpce` 経由のみ |

> S3 ゲートウェイエンドポイントやインターフェイスエンドポイントの `IpAddressType` でデプロイが失敗する場合、そのリージョンではまだ IPv6 に対応していません。
> `-c s3GatewayIpAddressType=ipv4` / `-c endpointIpAddressType=ipv4` で作り直し、結果に記録してください（その場合 IPv6 のみのモードは使えません）。

イメージのスキャン結果（Critical / High は計測前に解消する）とサービスを確認します。

```bash
source scripts/lib.sh
for uri in "$(out provider NetbenchImageUri)" "$(out provider LoadgenImageUri)"; do
  repo="${uri#*/}"; repo="${repo%%:*}"; tag="${uri##*:}"
  aws ecr describe-image-scan-findings --repository-name "$repo" --image-id imageTag="$tag" \
    --query 'imageScanFindings.findingSeverityCounts'
done
aws ecs describe-services --cluster "$PREFIX" --services svc-pl svc-lattice \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}' --output table
aws vpc-lattice list-targets --target-group-identifier "$(out provider LatticeTgArn)" \
  --query 'items[].{ip:id,port:port,status:status}' --output table
```

### 2.3 提供側の承諾とテストデータ

**提供側として** PrivateLink の接続を承諾し（セキュリティの制御 + S-6 の時間計測）、S3 のテスト用オブジェクトを置きます。

```bash
./scripts/accept-endpoint.sh
./scripts/upload-test-objects.sh
python3 scripts/measure-provisioning.py --prefix "$PREFIX" --csv results/provisioning.csv
```

> 承諾する前に 2.6 のプローブを一度実行してください。PrivateLink の経路は **つながらない** はずです（`pendingAcceptance`）。
> これがセキュリティのテスト X-2 です。

### 2.4 あとから設定を変える

新しいコンテキストで再デプロイします。cdkd は変わった部分だけを更新します（先に `npm run diff -- -c ...` で確認できます）。

```bash
npm run deploy -- -c latticeAuthMode=iam-required    # X-3
npm run deploy                                       # cdk.json の既定値に戻す
```

> 1 つのシナリオの間は、毎回同じ `-c` の値でデプロイしてください。付けずにデプロイすると `cdk.json` の既定値に戻ります。

### 2.5 負荷生成 EC2 に入る

CloudShell で、負荷生成 EC2 に渡す値を表示します（値は CloudShell にある `cdk-outputs.json` から読みます）。

```bash
./scripts/get-endpoints.sh
LOADGEN_ID=$(source scripts/lib.sh && out consumer LoadgenInstanceId)
aws ssm start-session --target "$LOADGEN_ID"
```

負荷生成 EC2 の中で：

```bash
sudo usermod -aG docker ssm-user && exec sudo -iu ssm-user   # 初回のみ
# get-endpoints.sh が表示した "export ..." の行をここに貼り付ける（LOADGEN_IMAGE も）
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${LOADGEN_IMAGE%%/*}"
docker pull "$LOADGEN_IMAGE"
mkdir -p ~/results
lg() { docker run --rm --network host --read-only --tmpfs /tmp --cap-drop ALL \
         --user "$(id -u):$(id -g)" -v "$HOME/results:/work/results" \
         -e AWS_REGION -e PL_DNS -e LATTICE_DNS -e S3IF_DNS -e DATA_BUCKET -e OUTSIDE_BUCKET \
         "$LOADGEN_IMAGE" "$@"; }
lg k6 version
```

### 2.6 動作確認（全経路、IPv6 と IPv4）

```bash
lg probe-paths.sh --context trusted
```

期待する結果（デュアルスタック、`latticeAuthMode=vpc-only`）：

| target | IPv6 | IPv4 | 提供側から見えたもの |
|--------|------|------|----------------------|
| pl-http | 200 | 200 | `remote` = NLB のアドレス、Lattice のヘッダーなし |
| lattice-http / lattice-https | 200 | 200 | `remote` = Lattice のリンクローカル、`src_vpc` = 利用側 VPC の ID |
| lattice-https-sigv4 | 200 | 200 | `identity` = 負荷生成 EC2 のロール |
| s3gw-data / s3if-data | 200 | 200 | — |
| s3gw-outside / s3if-outside | **403** | **403** | —（エンドポイントポリシーで遮断） |

> IPv6 のみのモードで、S3 や Lattice の IPv4 列が `timeout/refused` になるのは、IPv6 のみのサブネットとして正しい動きです。

---

## 3. スピードのシナリオ

詳細、仮説、見るべきポイントは [04-speed-scenarios.md](04-speed-scenarios.md) にあります。早見表：

```bash
# S-1 レイテンシ、接続の再利用あり、IPv6（3〜5 回繰り返し、毎回順番を変える）
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k"
lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k"
lg run-k6.sh --label s3-gateway    --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k" --rates "100 500"
lg run-k6.sh --label s3-interface  --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1k" --rates "100 500"

# S-2 リクエストごとに新しい接続
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"         --reuse no --rates "100 300"
lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k"   --reuse no --rates "100 300"

# S-3 同じ経路で IPv4 と IPv6
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k" --ip onlyIPv4
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k" --ip onlyIPv4

# S-4 スループット（1 MiB）
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1m"        --mode throughput --vus 32
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1m"   --mode throughput --vus 32
lg run-k6.sh --label s3-gateway    --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1m" --mode throughput --vus 32
lg run-k6.sh --label s3-interface  --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1m" --mode throughput --vus 32
```

S-0（提供側 VPC での基準値）と S-6（つながるまでの時間）は CloudShell で実行します。

```bash
./scripts/run-baseline.sh "100 500 1000" onlyIPv6
python3 scripts/measure-provisioning.py --prefix "$PREFIX"
```

負荷生成 EC2 の `~/results/k6.csv` を CloudShell に移し（小さいので、セッション上で `cat` して貼り付ける）、基準値の行を足してから集計します。

```bash
python3 scripts/summarize.py results/k6.csv --pivot total_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot total_p99_ms
python3 scripts/summarize.py results/k6.csv --pivot throughput_MBps
```

---

## 4. セキュリティのシナリオ

詳細と期待する結果の表は [05-security-scenarios.md](05-security-scenarios.md) にあります。早見表：

| ID | 内容 | 方法 |
|----|------|------|
| X-1 | ネットワーク層：同じ VPC の信頼しないクライアント | `./scripts/swap-client-sg.sh untrusted` → `lg probe-paths.sh --context untrusted` → `./scripts/swap-client-sg.sh trusted` |
| X-2 | PrivateLink の承諾 | `accept-endpoint.sh` の前にプローブ |
| X-3 | Lattice の認証ポリシー：匿名と SigV4 | `npm run deploy -- -c latticeAuthMode=iam-required` → `lg probe-paths.sh --context iam-required` |
| X-4 | 提供側から何が見えるか | `./scripts/source-ip-report.sh 60` |
| X-5 | エンドポイントポリシー + バケットポリシーによるデータ境界 | プローブの `s3*-outside` の行、CloudShell（インターネット）からの `curl` |
| X-6 | IPv4 の重複 | 両 VPC とも `10.0.0.0/16`。それでも上がすべて動いた |
| X-7 | 公開範囲のレビュー | [05-security-scenarios.md](05-security-scenarios.md#x-7-公開範囲のレビュー机上確認) |

---

## 5. 任意：IPv6 のみのワークロード

ワークロードのサブネットを IPv6 のみに切り替えます。サブネットの種類はその場では変えられないため、コンテキストを付けて **削除してから作り直し** ます。cdkd なら CloudFormation のスタック削除を待つより短い時間で済みます。

```bash
npm run destroy
npm run deploy -- -c workloadIpMode=ipv6only
./scripts/accept-endpoint.sh && ./scripts/upload-test-objects.sh
```

変わること：

- タスクには IPv6 アドレスだけが付く。NLB / Lattice のターゲットグループは `ipv6` / `IPV6` になり、**端から端まで IPv6**
- ECR、Logs、SSM に IPv6 で届く必要がある → エンドポイントをデュアルスタックにしている理由（プラクティス 2）
- 負荷生成 EC2 も IPv6 のみ。`--ip onlyIPv4` の計測は失敗するのが正しい
- S-1 をデュアルスタックと IPv6 のみで比べる（ターゲットまで IPv6 にすると何か変わるか）

> IPv6 のみのタスクでは ECS Exec が使えません。このハンズオンで ECS Exec を使わない理由の 1 つでもあります。

---

## 6. 後片付け

```bash
npm run destroy
```

`scripts/destroy.sh` は 2 つの S3 バケットを空にし、`cdkd destroy --all --yes` を実行し、`cdk-outputs.json` を消し、`Project=<prefix>` タグの付いたリソースが残っていないかを表示します（空になるはず）。

- イメージは cdkd のコンテナアセット用リポジトリに残る。参照されなくなったものは `npx cdkd gc` で消す（先に `npx cdkd gc --help` で確認）
- ほかで cdkd を使わないなら、`npx cdkd bootstrap --destroy` でそのリージョンの cdkd のアセット置き場を削除できる
- このハンズオンのためだけに作った予算は削除する

---

## 付録A. セキュリティチェックリスト

- [ ] 検証専用アカウントで実施している
- [ ] どちらの VPC にも IGW / NAT / EIGW がなく、パブリック IP がどこにもない
- [ ] NLB は内部向け。エンドポイントサービスは承諾必須で、自アカウントだけを許可している
- [ ] インターフェイスエンドポイント / Lattice の関連付け / S3 インターフェイスエンドポイントの SG は `TrustedClientSg` だけを許可している
- [ ] Lattice のサービスネットワークとサービスに認証ポリシー（`AWS_IAM`）があり、アクセスログが有効
- [ ] S3 のゲートウェイ / インターフェイスエンドポイントのポリシーは、必要なバケットの読み取りだけを許可している
- [ ] バケットポリシーは `aws:SourceVpce` 経由の読み取りだけを許可し、TLS 以外を拒否。ブロックパブリックアクセスが有効
- [ ] EC2：IMDSv2 必須、ホップ数上限 1、SSM のみ（SSH なし、インバウンドルールなし）、EBS 暗号化
- [ ] コンテナ：非 root、ルートは読み取り専用、ケーパビリティ全削除、ECS Exec なし、タスクロールに権限なし
- [ ] ECR のレジストリスキャンを有効にし、結果を確認した。イメージのタグは内容のハッシュ（ベースイメージはダイジェストで固定）
- [ ] `npm test` が成功している。`cdk-outputs.json` とデプロイログをコミット・共有していない
- [ ] SigV4 テストの認証情報は、コンテナ内で IMDS から取得し、標準入力で curl に渡している
- [ ] ログの保持期間を設定している（既定 7 日）
- [ ] 予算アラートを設定し、その日のうちにすべて削除した

## 付録B. トラブルシューティング

| 症状 | よくある原因 | 対処 |
|------|--------------|------|
| デプロイが `IpAddressType` で失敗 | そのリージョンでエンドポイントが IPv6 未対応 | `-c endpointIpAddressType=ipv4` / `-c s3GatewayIpAddressType=ipv4` を使う（デュアルスタックのモードのみ） |
| `Failed to acquire lock for stack` | 別の、または中断した cdkd の実行がロックを持っている | 待つ。ほかに実行中のものがなければ `npx cdkd force-unlock <stack>` |
| デプロイが途中で失敗 | cdkd が自動でロールバック。一部が適用されたままの可能性があるという表示 | 直して再デプロイ（前に進めて直す）、または `npx cdkd rollback <stack> --revert-failed` |
| `cdk-outputs.json not found` | `npm run deploy` が成功する前にスクリプトを実行した | 先にデプロイする。または `OUTPUTS_FILE` を指定 |
| デプロイ中に Docker のビルドが失敗 | Docker が動いていない、アーキテクチャの違い | `docker info`。`-c cpuArchitecture` をビルドするものに合わせる |
| タスクが `PROVISIONING` のまま / イメージ取得に失敗 | ECR / S3 のエンドポイント不足、エンドポイントポリシーが厳しすぎる | ECR のエンドポイントと、S3 ゲートウェイエンドポイントのポリシーの `EcrImageLayers` を確認 |
| 負荷生成 EC2 の `docker pull` が拒否される | ロールの対象外のリポジトリにイメージがある | ロールは `cdkd-container-assets-*` と `cdk-*-container-assets-*` を許可。`LoadgenImageUri` を確認 |
| 負荷生成 EC2 のユーザーデータで `dnf` が失敗 | S3 ゲートウェイエンドポイントのポリシー | `al2023-repos-<region>-*` の許可があるか確認 |
| PrivateLink が `timeout/refused` | まだ承諾していない、またはクライアントの SG が信頼しない側 | `./scripts/accept-endpoint.sh`、SG を確認 |
| Lattice が 403 | 認証ポリシー：送信元 VPC、または `iam-required` | デプロイしたときの `latticeAuthMode` と、アクセスログの `authDeniedReason` を確認 |
| Lattice のターゲットが `UNHEALTHY` | タスクの SG に Lattice の範囲がない | 8080 で `169.254.171.0/24` と `fd00:ec2:80::/64` を許可 |
| データ用バケットで S3 が 403 | 利用側のエンドポイントを通っていない、またはオブジェクトがない | デュアルスタックの S3 名 / vpce の名前を使う。`upload-test-objects.sh` を実行 |
| k6 の `dropped_iterations` が 0 でない | 負荷生成側の限界 | インスタンスを大きくするか、レートを下げる |
| `run-baseline.sh` が何も出力しない | k6 が動く前にタスクが失敗 | `aws ecs describe-tasks ... --query 'tasks[0].stoppedReason'` |
