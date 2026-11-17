# AWS コンテナネットワーク検証 — IPv6 を前提としたハンズオン

[English README](README.md)

> 登壇タイトル：**IPv6 を前提としたコンテナネットワーク設計のプラクティス**（JAWS-UG 山梨、2026-11-21、英語セッション）

**同じ ECS サービス** を **AWS PrivateLink** と **Amazon VPC Lattice** の後ろで動かし、さらに **AWS サービス向けの VPC エンドポイント（S3 ゲートウェイ / インターフェイス）** も加えて、**IPv6 前提** の VPC で次の 2 つの観点から比べるハンズオン一式です。

| # | 観点 | 主な問い |
|---|------|----------|
| 1 | **スピード** | 経路ごとに遅延はどれだけ増えるか（p50 / p99）。新しい接続や TLS のコストは。IPv6 は IPv4 より遅いか。新しい利用者が呼べるようになるまで何秒かかるか |
| 2 | **セキュリティ** | 誰がその経路に届き、誰が許可を決めるか。提供側は呼び出し元について何がわかるか。エンドポイントポリシーとバケットポリシーでどうデータ境界を作るか |

## 比べる経路

| ID | 経路 | クライアントから |
|----|------|------------------|
| ① | **PrivateLink** | デュアルスタックのインターフェイスエンドポイント → エンドポイントサービス（承諾が必要）→ デュアルスタックの内部 NLB → ECS `svc-pl` |
| ② | **VPC Lattice** | サービスネットワークの VPC 関連付け（SG 付き）→ Lattice サービス（HTTP / HTTPS、IAM 認証ポリシー）→ ECS `svc-lattice` |
| ③ | **VPC エンドポイント** | S3 ゲートウェイエンドポイント（デュアルスタック）と S3 インターフェイスエンドポイント（デュアルスタック）。どちらもエンドポイントポリシー付き |
| S-0 | 基準値 | 提供側 VPC の中の k6 → NLB（PrivateLink を通らない） |

2 つの VPC は **わざと同じ `10.0.0.0/16`** にしています。どちらにもインターネットゲートウェイ・NAT・Egress-only IGW はありません。

## ドキュメント

| | English | 日本語 |
|---|---|---|
| 概要・伝えたいこと・仮説 | [docs/en/01-overview.md](docs/en/01-overview.md) | [docs/ja/01-overview.md](docs/ja/01-overview.md) |
| 構成と IPv6 設計のプラクティス | [docs/en/02-architecture.md](docs/en/02-architecture.md) | [docs/ja/02-architecture.md](docs/ja/02-architecture.md) |
| **ハンズオン手順** | [docs/en/03-handson-guide.md](docs/en/03-handson-guide.md) | [docs/ja/03-handson-guide.md](docs/ja/03-handson-guide.md) |
| スピードのシナリオ（S-0〜S-6） | [docs/en/04-speed-scenarios.md](docs/en/04-speed-scenarios.md) | [docs/ja/04-speed-scenarios.md](docs/ja/04-speed-scenarios.md) |
| セキュリティのシナリオ（X-1〜X-7） | [docs/en/05-security-scenarios.md](docs/en/05-security-scenarios.md) | [docs/ja/05-security-scenarios.md](docs/ja/05-security-scenarios.md) |
| 登壇スクリプト（20 分、10 分版の削り方つき） | [docs/en/06-talk-script-en.md](docs/en/06-talk-script-en.md) | [docs/ja/06-talk-script.md](docs/ja/06-talk-script.md) |
| 当日までの手順 | [docs/en/07-event-runbook.md](docs/en/07-event-runbook.md) | [docs/ja/07-event-runbook.md](docs/ja/07-event-runbook.md) |
| 結果のテンプレート（スライド用） | [docs/en/result-template.md](docs/en/result-template.md) | [docs/ja/result-template.md](docs/ja/result-template.md) |
| 参考資料 | [docs/en/references.md](docs/en/references.md) | [docs/ja/references.md](docs/ja/references.md) |

## リポジトリ構成

```
.
├── README.md / README.ja.md
├── cfn/
│   ├── 01-vpc.yaml                  VPC（consumer / provider の 2 回デプロイ）、デュアルスタックのエンドポイント、Flow Logs
│   ├── 02-provider-platform.yaml    ECR、ECS クラスター、IAM、NLB + エンドポイントサービス、VPC Lattice
│   ├── 03-provider-services.yaml    タスク定義、svc-pl、svc-lattice、基準値用タスク
│   └── 04-consumer.yaml             負荷生成 EC2、PrivateLink エンドポイント、Lattice 関連付け、S3 とエンドポイント
├── docker/
│   ├── netbench/                    計測対象：nginx（非 root、IPv4 + IPv6、/whoami で提供側から見えた情報を返す）
│   └── loadgen/                     k6 + curl + dig + スクリプト
├── scripts/
│   ├── k6-load.js / run-k6.sh       レイテンシ / スループット（IPv6 / IPv4、接続の再利用あり / なし）
│   ├── probe-paths.sh               全経路・両アドレスファミリーの到達性と識別情報の確認
│   ├── run-baseline.sh              S-0：提供側 VPC の Fargate タスクで基準値を計測
│   ├── accept-endpoint.sh           提供側で PrivateLink 接続を承諾（所要時間も記録）
│   ├── measure-provisioning.py      S-6：新しい利用者がつながるまでの時間
│   ├── swap-client-sg.sh            信頼する / 信頼しないクライアント SG の切り替え（X-1）
│   ├── source-ip-report.sh          提供側から見えた送信元（Logs Insights）
│   ├── upload-test-objects.sh       S3 のテスト用オブジェクト
│   ├── get-endpoints.sh             負荷生成 EC2 に貼り付ける値を表示
│   └── summarize.py                 スライド用の Markdown 表を作る
├── docs/en, docs/ja                 シナリオ、登壇スクリプト、当日の手順（英語 / 日本語）
└── results/                         計測結果の置き場所（コミットしない）
```

## クイックスタート

```bash
export AWS_REGION=ap-northeast-1 PREFIX=v6lab
for role in consumer provider; do
  aws cloudformation deploy --stack-name "$PREFIX-$role-vpc" --template-file cfn/01-vpc.yaml \
    --parameter-overrides Prefix=$PREFIX Role=$role --capabilities CAPABILITY_IAM
done
aws cloudformation deploy --stack-name "$PREFIX-provider-platform" --template-file cfn/02-provider-platform.yaml \
  --parameter-overrides Prefix=$PREFIX --capabilities CAPABILITY_IAM
# イメージをビルドして push し、03 と 04 をデプロイ（手順はハンズオンガイド）
```

詳しい手順は [docs/ja/03-handson-guide.md](docs/ja/03-handson-guide.md) にあります。

## セキュリティ方針

- **検証専用アカウント** で実施し、その日のうちにすべて削除する
- **インターネットへの経路を持たない**：IGW / NAT / EIGW なし、パブリック IP なし、NLB は内部向けのみ
- すべての経路で多層防御：エンドポイント / 関連付けの SG → 承諾 / 認証ポリシー / エンドポイントポリシー → バケットポリシー
- PrivateLink のエンドポイントサービス：承諾必須、許可するプリンシパルは自アカウントのみ
- VPC Lattice：サービスネットワークとサービスの両方で `AWS_IAM` 認証、アクセスログを有効化
- S3：ブロックパブリックアクセスを有効、読み取りは `aws:SourceVpce` 経由のみ、TLS 必須、エンドポイントポリシーで必要なバケットだけに限定
- EC2：IMDSv2 必須（ホップ数上限 1）、SSM のみ（SSH なし、インバウンドルールなし）、EBS 暗号化
- コンテナ：非 root、ルートファイルシステムは読み取り専用、Linux ケーパビリティはすべて削除、ECS Exec なし、タスクロールに権限なし
- イメージは push 時にスキャン（ECR、KMS、タグ変更不可）し、ダイジェストで指定
- SigV4 のテストでは、コンテナ内で IMDSv2 からインスタンスロールの認証情報を取得し、標準入力経由で curl に渡す（コマンドラインに出さない）
- CI（`.github/workflows/validate.yml`）は読み取り専用トークンで cfn-lint、shellcheck、checkov を実行

許容している checkov の指摘（短期間の検証環境のため）：

| チェック | ここで許容する理由 | 本番では |
|----------|--------------------|----------|
| CKV_AWS_158 ロググループに KMS キーがない | 保持 7 日、ログに秘密情報を含まない | カスタマー管理の KMS キーを使う |
| CKV_AWS_18 / CKV_AWS_21 S3 のアクセスログ / バージョニング | ランダムなテストデータのバケット 2 つで、その日のうちに削除する | 両方有効にする（または CloudTrail のデータイベント） |
| CKV_AWS_91 NLB のアクセスログ | NLB のアクセスログは TLS リスナーのみが対象。この NLB は TCP | TLS リスナーにして有効化 |
| CKV_DOCKER_2 / CKV_DOCKER_7 HEALTHCHECK / ベースイメージのタグ | ヘルスチェックは NLB / Lattice が行う。ガイドでビルド時にダイジェストで固定する | Dockerfile でダイジェストを固定 |

## コスト

起動中は、インターフェイスエンドポイント（AZ ごと、2 VPC 分）、NLB、Lattice サービス、Fargate タスク 4 つ、EC2 1 台の料金がかかります。1 時間あたり数 USD 程度を見込み、最新の料金を確認したうえで、計測後すぐにスタックを削除してください。

## ライセンス

Apache License 2.0
