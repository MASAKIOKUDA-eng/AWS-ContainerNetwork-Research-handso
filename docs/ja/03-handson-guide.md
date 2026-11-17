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
- 日時、リージョン、負荷生成とタスクの AZ、インスタンスタイプ、イメージのダイジェストを記録する
- 繰り返すたびに経路の **順番を変える**（「最初の回だけ遅い」の偏りを避ける）

## 1. 事前準備

### 1.1 必要なもの

| 項目 | 内容 |
|------|------|
| AWS アカウント | **検証専用アカウント** |
| 実行環境 | **AWS CloudShell を推奨**（手元に長期のアクセスキーを置かずに済む。bash、AWS CLI v2、jq、Docker、Python 3 がある） |
| リージョン | 例：`ap-northeast-1`。VPC Lattice、ECR / Logs / SSM のデュアルスタックのエンドポイント、S3 ゲートウェイエンドポイントの IPv6 が使えることを確認する |
| 権限 | CloudFormation で IAM ロールを作れる権限。検証後に外す |
| コスト | 起動中は 1 時間あたり数 USD 程度（インターフェイスエンドポイント × AZ × 2 VPC、NLB、Fargate、Lattice、EC2）。**その日のうちに削除する** |

### 1.2 環境変数

```bash
export AWS_REGION=ap-northeast-1
export PREFIX=v6lab
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
git clone https://github.com/MASAKIOKUDA-eng/AWS-ContainerNetwork-Research-handso.git
cd AWS-ContainerNetwork-Research-handso
```

> スクリプトは `PREFIX=v6lab` のような名前（英小文字・数字・`-` で 3〜16 文字）を前提にしています。

### 1.3 予算アラート

```bash
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"'"$PREFIX"'","BudgetLimit":{"Amount":"30","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<your-mail>"}]}]'
```

すべてのリソースに `Project=<prefix>` タグが付きます。Cost Explorer でハンズオン分を集計したい場合は、コスト配分タグとして有効化してください。

---

## 2. 環境構築

### 2.1 VPC（利用側と提供側）

```bash
for role in consumer provider; do
  aws cloudformation deploy --stack-name "$PREFIX-$role-vpc" \
    --template-file cfn/01-vpc.yaml \
    --parameter-overrides Prefix="$PREFIX" Role="$role" WorkloadIpMode=dualstack \
    --capabilities CAPABILITY_IAM
done
```

| リソース | ポイント |
|----------|----------|
| VPC `10.0.0.0/16`（**両方とも**）+ Amazon 提供の IPv6 /56 | IPv4 はわざと重複（X-6） |
| エッジ サブネット × 2（デュアルスタック） | NLB と VPC エンドポイントを置く |
| ワークロード サブネット × 2（`dualstack` または `ipv6only`） | ECS タスクと負荷生成 EC2 |
| ローカルルートだけのルートテーブル | IGW / NAT / EIGW なし。検証対象の経路以外では外に出られない |
| デュアルスタックのインターフェイスエンドポイント | ECR API / ECR DKR / Logs（利用側は SSM × 3 も） |
| S3 ゲートウェイエンドポイント（`IpAddressType: dualstack`） | **エンドポイントポリシー**：ECR のレイヤー用バケット、AL2023 のリポジトリ、（利用側は）データ用バケットだけ |
| Flow Logs | `pkt-srcaddr`、`pkt-dstaddr`、`flow-direction`、`traffic-path` を含むカスタム形式 |

> S3 ゲートウェイエンドポイントやインターフェイスエンドポイントの `IpAddressType` でスタックが失敗する場合、そのリージョンではまだ IPv6 に対応していません。
> `S3GatewayIpAddressType=ipv4` / `EndpointIpAddressType=ipv4` で作り直し、結果に記録してください（その場合 IPv6 のみのモードは使えません）。

### 2.2 提供側の基盤

```bash
aws cloudformation deploy --stack-name "$PREFIX-provider-platform" \
  --template-file cfn/02-provider-platform.yaml \
  --parameter-overrides Prefix="$PREFIX" ProviderWorkloadIpMode=dualstack LatticeAuthMode=vpc-only \
  --capabilities CAPABILITY_IAM
```

| リソース | ポイント |
|----------|----------|
| 内部 NLB `IpAddressType: dualstack` + TCP 80 → ターゲットグループ（ip、8080） | ターゲットグループのファミリーは、デュアルスタックでは IPv4、IPv6 のみでは IPv6 |
| VPC エンドポイントサービス | `AcceptanceRequired: true`、`SupportedIpAddressTypes: [ipv4, ipv6]`、許可するプリンシパルは自アカウントのみ |
| Lattice サービスネットワーク（`AWS_IAM`） | 認証ポリシー：**利用側 VPC からのみ** |
| Lattice サービス（`AWS_IAM`）+ HTTP 80 / HTTPS 443 リスナー | 認証ポリシーを `LatticeAuthMode` で切り替え：`vpc-only` / `iam-required` |
| Lattice ターゲットグループ（IP、HTTP 8080） | ECS がタスクを登録する（ロードバランサーなし） |
| Lattice アクセスログ → CloudWatch Logs | 認証の判断、呼び出し元のプリンシパル、送信元 VPC、ターゲットのアドレス |
| ECR × 2（タグ変更不可、push 時スキャン、KMS）、ECS クラスター（Container Insights 強化版） | |
| IAM：タスク実行ロール、**権限のない** タスクロール、Lattice 用の ECS インフラストラクチャロール | |

### 2.3 コンテナイメージ

CloudShell など Docker が使える環境でビルドします。

```bash
out() { aws cloudformation describe-stacks --stack-name "$PREFIX-$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
REPO_NB=$(out provider-platform NetbenchRepoUri)
REPO_LG=$(out provider-platform LoadgenRepoUri)
aws ecr get-login-password | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# 公開する数字を取るときは、ベースイメージをダイジェストで固定する（--build-arg BASE=...@sha256:...）
docker build --platform linux/amd64 -t "$REPO_NB:v1" docker/netbench
docker build --platform linux/amd64 -t "$REPO_LG:v1" -f docker/loadgen/Dockerfile .
docker push "$REPO_NB:v1"
docker push "$REPO_LG:v1"

NB_DIGEST=$(aws ecr describe-images --repository-name "$PREFIX/netbench" --image-ids imageTag=v1 --query 'imageDetails[0].imageDigest' --output text)
LG_DIGEST=$(aws ecr describe-images --repository-name "$PREFIX/loadgen"  --image-ids imageTag=v1 --query 'imageDetails[0].imageDigest' --output text)
export NETBENCH_IMAGE="$REPO_NB@$NB_DIGEST"
export LOADGEN_IMAGE="$REPO_LG@$LG_DIGEST"
```

先に進む前にスキャン結果を確認し、Critical / High があれば解消します。

```bash
for r in netbench loadgen; do
  aws ecr describe-image-scan-findings --repository-name "$PREFIX/$r" --image-id imageTag=v1 \
    --query 'imageScanFindings.findingSeverityCounts'
done
```

### 2.4 提供側のサービス

```bash
aws cloudformation deploy --stack-name "$PREFIX-provider-services" \
  --template-file cfn/03-provider-services.yaml \
  --parameter-overrides Prefix="$PREFIX" NetbenchImage="$NETBENCH_IMAGE" LoadgenImage="$LOADGEN_IMAGE"
```

- `svc-pl` は NLB のターゲットグループにタスクを登録する（`LoadBalancers`）
- `svc-lattice` は Lattice のターゲットグループにタスクを登録する（`VpcLatticeConfigurations`、ポート名 `http`）

```bash
aws ecs describe-services --cluster "$PREFIX" --services svc-pl svc-lattice \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}' --output table
aws vpc-lattice list-targets --target-group-identifier "$(out provider-platform LatticeTgArn)" \
  --query 'items[].{ip:id,port:port,status:status}' --output table
```

### 2.5 利用側

```bash
aws cloudformation deploy --stack-name "$PREFIX-consumer" \
  --template-file cfn/04-consumer.yaml \
  --parameter-overrides Prefix="$PREFIX" \
  --capabilities CAPABILITY_IAM
```

続けて **提供側として** PrivateLink の接続を承諾し（セキュリティの制御 + S-6 の時間計測）、S3 のテスト用オブジェクトを置きます。

```bash
./scripts/accept-endpoint.sh
./scripts/upload-test-objects.sh
python3 scripts/measure-provisioning.py --prefix "$PREFIX" --csv results/provisioning.csv
```

> 承諾する前に 2.7 のプローブを一度実行してください。PrivateLink の経路は **つながらない** はずです（`pendingAcceptance`）。
> これがセキュリティのテスト X-2 です。

### 2.6 負荷生成 EC2 に入る

CloudShell で、負荷生成 EC2 に渡す値を表示します（負荷生成 EC2 からは CloudFormation の API に届きません。経路がないためです）。

```bash
./scripts/get-endpoints.sh
LOADGEN_ID=$(out consumer LoadgenInstanceId)
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

### 2.7 動作確認（全経路、IPv6 と IPv4）

```bash
lg probe-paths.sh --context trusted
```

期待する結果（デュアルスタック、`LatticeAuthMode=vpc-only`）：

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
| X-3 | Lattice の認証ポリシー：匿名と SigV4 | 02 を `LatticeAuthMode=iam-required` で更新 → `lg probe-paths.sh --context iam-required` |
| X-4 | 提供側から何が見えるか | `./scripts/source-ip-report.sh 60` |
| X-5 | エンドポイントポリシー + バケットポリシーによるデータ境界 | プローブの `s3*-outside` の行、CloudShell（インターネット）からの `curl` |
| X-6 | IPv4 の重複 | 両 VPC とも `10.0.0.0/16`。それでも上がすべて動いた |
| X-7 | 公開範囲のレビュー | [05-security-scenarios.md](05-security-scenarios.md#x-7-公開範囲のレビュー机上確認) |

---

## 5. 任意：IPv6 のみのワークロード

ワークロードのサブネットを IPv6 のみに切り替えます。サブネットの種類はその場では変えられないため、**逆順に削除してから** `WorkloadIpMode=ipv6only`（スタック 02 は `ProviderWorkloadIpMode=ipv6only`）で作り直します。

```bash
# 6.（後片付け）でスタック 04、03、02 と両 VPC のスタックを消した後：
for role in consumer provider; do
  aws cloudformation deploy --stack-name "$PREFIX-$role-vpc" --template-file cfn/01-vpc.yaml \
    --parameter-overrides Prefix="$PREFIX" Role="$role" WorkloadIpMode=ipv6only --capabilities CAPABILITY_IAM
done
# 続けて 2.2（ProviderWorkloadIpMode=ipv6only）、2.3、2.4、2.5 を同じように実行
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
aws cloudformation delete-stack --stack-name "$PREFIX-consumer"
aws cloudformation wait stack-delete-complete --stack-name "$PREFIX-consumer"
aws cloudformation delete-stack --stack-name "$PREFIX-provider-services"
aws cloudformation wait stack-delete-complete --stack-name "$PREFIX-provider-services"
aws cloudformation delete-stack --stack-name "$PREFIX-provider-platform"
aws cloudformation wait stack-delete-complete --stack-name "$PREFIX-provider-platform"
for role in consumer provider; do aws cloudformation delete-stack --stack-name "$PREFIX-$role-vpc"; done
```

- スタック 04 が S3 バケットを消すには、先に **中身を空に** する必要がある：
  `aws s3 rm "s3://$PREFIX-data-$ACCOUNT_ID" --recursive && aws s3 rm "s3://$PREFIX-outside-$ACCOUNT_ID" --recursive`
- ECR リポジトリは中のイメージごと削除される（`EmptyOnDelete`）
- 消し忘れの確認：`aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=$PREFIX --query 'ResourceTagMappingList[].ResourceARN'`
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
- [ ] イメージは ECR でスキャン済みで、ダイジェストで指定している（ベースイメージもダイジェストで固定）
- [ ] SigV4 テストの認証情報は、コンテナ内で IMDS から取得し、標準入力で curl に渡している
- [ ] ログの保持期間を設定している（既定 7 日）
- [ ] 予算アラートを設定し、その日のうちにすべて削除した

## 付録B. トラブルシューティング

| 症状 | よくある原因 | 対処 |
|------|--------------|------|
| `01-vpc` が `IpAddressType` で失敗 | そのリージョンでエンドポイントが IPv6 未対応 | `EndpointIpAddressType=ipv4` / `S3GatewayIpAddressType=ipv4` を使う（デュアルスタックのモードのみ） |
| タスクが `PROVISIONING` のまま / イメージ取得に失敗 | ECR / S3 のエンドポイント不足、エンドポイントポリシーが厳しすぎる | ECR のエンドポイントと、S3 ゲートウェイエンドポイントのポリシーの `EcrImageLayers` を確認 |
| 負荷生成 EC2 のユーザーデータで `dnf` が失敗 | S3 ゲートウェイエンドポイントのポリシー | `al2023-repos-<region>-*` の許可があるか確認 |
| PrivateLink が `timeout/refused` | まだ承諾していない、またはクライアントの SG が信頼しない側 | `./scripts/accept-endpoint.sh`、SG を確認 |
| Lattice が 403 | 認証ポリシー：送信元 VPC、または `iam-required` | `LatticeAuthMode` とアクセスログの `authDeniedReason` を確認 |
| Lattice のターゲットが `UNHEALTHY` | タスクの SG に Lattice の範囲がない | 8080 で `169.254.171.0/24` と `fd00:ec2:80::/64` を許可 |
| データ用バケットで S3 が 403 | 利用側のエンドポイントを通っていない、またはオブジェクトがない | デュアルスタックの S3 名 / vpce の名前を使う。`upload-test-objects.sh` を実行 |
| k6 の `dropped_iterations` が 0 でない | 負荷生成側の限界 | インスタンスを大きくするか、レートを下げる |
| `run-baseline.sh` が何も出力しない | k6 が動く前にタスクが失敗 | `aws ecs describe-tasks ... --query 'tasks[0].stoppedReason'` |
