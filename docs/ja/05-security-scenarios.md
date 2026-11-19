# 05. セキュリティのシナリオ

[English](../en/05-security-scenarios.md)

どの経路にも同じ問いを立てます：**誰が届くのか、誰が許可を決めるのか、提供側は呼び出し元について何がわかるのか。**

プローブ（`lg probe-paths.sh --context <名前>`）は、すべての対象を IPv6 と IPv4 で呼び、対象 × ファミリーごとに 1 行を `results/probe.csv` に書きます。ハンズオンのリソースに GET するだけです。

## ハンズオンでの制御の層

| 層 | PrivateLink ① | VPC Lattice ② | VPC エンドポイント ③（S3） |
|----|---------------|---------------|----------------------------|
| ネットワーク（利用側） | インターフェイスエンドポイントの SG（`PrivateLinkEndpointSg`） | VPC 関連付けの SG（`LatticeAssociationSg`） | インターフェイスエンドポイントの SG。ゲートウェイはルートテーブル |
| 接続 | エンドポイントサービス：許可するプリンシパル + **承諾** | サービスネットワーク（送信元 VPC）とサービス（匿名 / SigV4）の **認証ポリシー** | **エンドポイントポリシー**（どのバケットに、どの操作を） |
| リソース | （アプリ自身） | （アプリ自身）+ 識別ヘッダー | `aws:SourceVpce` 付きの **バケットポリシー** |
| 提供側のネットワーク | NLB の SG（`EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic`）、タスクの SG は NLB の SG から | タスクの SG は Lattice のリンクローカル範囲から | — |
| ログ | Flow Logs、提供側のアクセスログ（`remote` = NLB） | **Lattice のアクセスログ**（プリンシパル、送信元 VPC、拒否理由）、提供側のアクセスログ | Flow Logs（有効なら CloudTrail のデータイベント） |

## X-1 同じ VPC の信頼しないクライアント（ネットワーク層）

インスタンス、DNS、ルートは同じで、セキュリティグループだけを変えます。

```bash
# CloudShell
./scripts/swap-client-sg.sh untrusted
# 負荷生成 EC2
lg probe-paths.sh --context untrusted
# CloudShell — 必ず元に戻す
./scripts/swap-client-sg.sh trusted
```

| target | trusted | untrusted | 理由 |
|--------|---------|-----------|------|
| pl-http | 200 | timeout | インターフェイスエンドポイントの SG が `TrustedClientSg` だけを許可 |
| lattice-http / -https | 200 | timeout | 関連付けの SG が `TrustedClientSg` だけを許可 |
| s3if-data | 200 | timeout | S3 インターフェイスエンドポイントの SG |
| s3gw-data | 200 | **200** | ゲートウェイエンドポイントは ENI ではなくルートなので **SG がない**。エンドポイントポリシー、バケットポリシー、クライアント側 SG のアウトバウンド（プレフィックスリスト）で制御する |

> 登壇ネタ：「ゲートウェイエンドポイント = ルートテーブルのエントリ」だから、制御は SG ではなくポリシーになる。

## X-2 PrivateLink の承諾（接続の層）

`./scripts/accept-endpoint.sh` の **前に** プローブを実行します。

- エンドポイントが `pendingAcceptance` の間、`pl-http` は timeout / refused
- 承諾した後は 200

> **DNS のネガティブキャッシュ**：`pendingAcceptance` の間はエンドポイントの DNS 名がまだ存在しない（NXDOMAIN、プローブでは `A=0 AAAA=0`）。
> VPC のリゾルバーはこの応答をキャッシュするため、2026-11-19 の実施では承諾後も利用側 VPC の中で約 9.7 分間名前解決に失敗した（外からはすでに解決できていた）。
> スピードのシナリオの前に、負荷生成 EC2 で `dig +short AAAA $PL_DNS` が答えることを確認する。
> 設計の教訓：承認 **前** に名前を引いた利用者は、人の承認に加えてネガティブキャッシュの TTL も待つことになる（S-6）。

`aws ec2 describe-vpc-endpoint-service-permissions --service-id <id>` も確認します。許可されているのは自アカウントだけです。別アカウントの利用者は、エンドポイントを作ることもできません。

## X-3 Lattice の認証ポリシー：匿名と SigV4

```bash
# CloudShell：自アカウントの署名付きの呼び出しだけを許可
npm run deploy -- -c latticeAuthMode=iam-required
# 負荷生成 EC2
lg probe-paths.sh --context iam-required
```

| target | vpc-only | iam-required |
|--------|----------|--------------|
| lattice-http（匿名） | 200 | **403** |
| lattice-https（匿名） | 200 | **403** |
| lattice-https-sigv4（負荷生成 EC2 のロール） | 200 | 200 |

- Lattice のアクセスログを確認：403 は `authDeniedReason`、署名付きは `callerPrincipal`
- スピードのシナリオの前に `npm run deploy`（既定値は `vpc-only`）で戻す（k6 の計測では署名しない）

## X-4 提供側からは何が見えるか

```bash
./scripts/source-ip-report.sh 60
```

| 経路 | タスクから見た `remote` | ほかにわかること |
|------|------------------------|------------------|
| PrivateLink | 提供側 VPC の **NLB のアドレス**（PrivateLink では呼び出し元の IP は保持されない） | なし。アプリが対応していれば、ターゲットグループの Proxy Protocol v2 でエンドポイントとクライアントのアドレスを渡せる |
| VPC Lattice | **Lattice のリンクローカルアドレス**（`169.254.171.x` / `fd00:ec2:80::…`） | `x-forwarded-for`、`x-amzn-source-vpc`、SigV4 なら `x-amzn-lattice-identity`（プリンシパル） |

> 設計への影響：提供側が **呼び出し元ごと** に認可する必要があるなら、PrivateLink ではそれをアプリに持たせることになる（mTLS、トークンなど）。Lattice ならネットワークの層で識別情報が手に入る。

## X-5 エンドポイントポリシー + バケットポリシーによるデータ境界

| リクエスト | 結果 | 効いている制御 |
|------------|------|----------------|
| 利用側から `s3gw-data`、`s3if-data` | 200 | エンドポイントポリシーがデータ用バケットを許可、バケットポリシーがエンドポイントを許可 |
| 利用側から `s3gw-outside`、`s3if-outside` | **403** | バケットポリシーはエンドポイントを **許可している** が、**エンドポイントポリシー** にそのバケットがない |
| CloudShell（インターネット）からデータ用バケット | **403** | バケットポリシー：`aws:SourceVpce` 経由のみ |

```bash
# CloudShell（インターネット経由）
curl -s -o /dev/null -w '%{http_code}\n' "https://$PREFIX-data-$ACCOUNT_ID.s3.dualstack.$AWS_REGION.amazonaws.com/1k"
```

> 登壇ネタ：エンドポイントポリシーは *この VPC からデータをどこに出せるか*（持ち出し対策）、バケットポリシーは *データをどこから読めるか*（リソースの境界）を決める。両方ほしい。

## X-6 IPv4 の重複

両 VPC とも `10.0.0.0/16` です。ピアリングや Transit Gateway ではつなげませんが、3 つの経路はどれも VPC の CIDR 間をルーティングしないので動きます。IPv6 はもともとグローバルに一意ですが、*IPv4 の名残* を気にしなくて済むのは接続の層のおかげです。

## X-7 公開範囲のレビュー（机上確認）

テンプレートを根拠にして、チームで埋めます。

| 問い | PrivateLink | VPC Lattice | VPC エンドポイント |
|------|-------------|-------------|--------------------|
| 利用側に何が公開されているか | NLB のリスナー 1 つ（TCP 80） | ネットワーク内のサービス、リスナー / パスごと | AWS サービスの API（エンドポイントポリシーで制限） |
| 利用側から提供側 VPC のほかのものに届くか | 届かない | 届かない | 対象外 |
| 提供側から利用側に接続を始められるか | できない（一方向） | できない（利用側もサービスを公開していない限り） | 対象外 |
| 新しい利用者を誰が承認するか | 提供側（承諾）+ 許可するプリンシパル | サービスネットワークの所有者（関連付け / RAM 共有）+ 認証ポリシー | 利用側自身（エンドポイントポリシー）+ リソースの所有者（バケットポリシー） |
| 呼び出し元の識別情報ごとにルールを書けるか | 書けない（アプリで行う） | 書ける（認証ポリシーの条件でプリンシパル、タグ、組織） | AWS の API なら書ける（エンドポイントポリシーの条件） |
| 拒否はどこで見えるか | Flow Logs（`REJECT`）、アプリのログ | Lattice のアクセスログ | CloudTrail（`AccessDenied`）、S3 サーバーアクセスログ |
| IPv6 特有の点 | NLB のデュアルスタック + `SupportedIpAddressTypes` | SG で `fd00:ec2:80::/64` を許可 | デュアルスタックの名前（`s3.dualstack…`）、エンドポイントの `IpAddressType` |

## 結果の記録

`results/probe.csv` は、コンテキスト × 対象 × ファミリーごとに 1 行です。スライドでは「対象 × コンテキスト」の表にして、✓（2xx）、✗403、✗timeout で示します。[result-template.md](result-template.md) を参照してください。
