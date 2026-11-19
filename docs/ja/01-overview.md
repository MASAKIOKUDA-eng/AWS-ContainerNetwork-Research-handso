# 01. 登壇資料のための概要

[English](../en/01-overview.md)

## イベント

| 項目 | 値 |
|------|----|
| イベント | JAWS-UG 山梨（connpass イベント 411061）— https://jaws-ug-yamanashi.connpass.com/event/411061/ |
| 日付 | 2026-11-21（土） |
| 言語 | 英語 |
| 持ち時間 | **connpass のタイムテーブルで確認する。** [06-talk-script.md](06-talk-script.md) は 20 分版で、10 分版にするときに削るスライドに印を付けている |

## 登壇タイトル

**IPv6-first container network design practices**（IPv6 を前提としたコンテナネットワーク設計のプラクティス）
— AWS PrivateLink、VPC エンドポイント、VPC Lattice をスピードとセキュリティで比べた、ハンズオンの実測値から

スライドのフッター用の短いタイトル：*IPv6-first container networking on AWS*

## 概要文（connpass / 最初のスライド用、英語）

> IPv4 addresses are now a cost line on the AWS bill, and Amazon ECS can run tasks in IPv6-only subnets since 2025.
> But "turn on IPv6" is the easy part. The hard part is how containers in different VPCs talk to each other and to AWS services.
> In this talk I compare three building blocks — AWS PrivateLink, VPC endpoints for AWS services, and Amazon VPC Lattice —
> on two axes: **speed** (latency, handshake cost, throughput, time to connect a new consumer) and **security**
> (who can call whom, what the provider can see, how to build a data perimeter).
> All numbers come from an open hands-on lab you can deploy in your own account.

（訳）パブリック IPv4 アドレスは AWS の請求書に載るコストになり、Amazon ECS は 2025 年から IPv6 のみのサブネットでタスクを動かせるようになりました。とはいえ「IPv6 を有効にする」のは簡単な部分です。難しいのは、別々の VPC にあるコンテナどうしや AWS サービスとどうつなぐかです。本セッションでは AWS PrivateLink、AWS サービス向けの VPC エンドポイント、Amazon VPC Lattice の 3 つを、**スピード**（遅延、ハンドシェイクのコスト、スループット、新しい利用者がつながるまでの時間）と **セキュリティ**（誰が誰を呼べるか、提供側に何が見えるか、データ境界をどう作るか）の 2 軸で比べます。数値はすべて、各自のアカウントで再現できる公開ハンズオンで計測したものです。

## 一言でいうと

> **自分で管理できる層は IPv6 を前提に設計し、IPv4 の世界との橋渡しは接続の層（PrivateLink / Lattice / エンドポイント）に任せる。どれを使うかは速さではなく「呼び出し元について何を知る必要があるか」で決める。**

（最後の部分は仮説です。計測結果に合わせて書き換えます。[result-template.md](result-template.md) を参照）

## 聞き手に持ち帰ってほしいこと

1. **IPv6 前提 ≠ どこでも IPv6 のみ。** エッジのサブネット（NLB、エンドポイント）はデュアルスタックのまま、依存先が対応していればワークロードのサブネットを IPv6 のみにする
2. **3 つは解決する問題が違う**
   - PrivateLink = *1 つの TCP エンドポイント* を多くの VPC / アカウントに公開する。L4。提供側には呼び出し元が見えない
   - AWS サービス向け VPC エンドポイント = AWS の API にプライベートに届く。*エンドポイントポリシーがデータ境界* になる
   - VPC Lattice = サービス間の *アプリケーションネットワーク*。IAM 認証、識別ヘッダー、L7 のルーティング
3. **IPv4 の CIDR が重なっていても問題にならない**（このハンズオンでは両側ともわざと `10.0.0.0/16`）
4. **速さの差はあるが、TLS や接続の再利用の決め方に比べれば小さい**（仮説。S-1 / S-2 で確かめる）
5. **セキュリティの層の重ね方が違う**：エンドポイント / 関連付けの SG、エンドポイントサービスの承諾、認証ポリシー、エンドポイントポリシー、バケットポリシー

## ひと目でわかる比較（ハンズオンの結果で埋める）

| | PrivateLink（エンドポイントサービス） | AWS サービス向け VPC エンドポイント | VPC Lattice |
|---|---|---|---|
| 層 | L4（NLB 経由の TCP / UDP） | L4（インターフェイス）/ ルート（ゲートウェイ） | L7（HTTP / HTTPS / gRPC）、TLS パススルー、リソース設定経由の TCP |
| このハンズオンでの IPv6 | デュアルスタック NLB + `SupportedIpAddressTypes: [ipv4, ipv6]` + デュアルスタックのインターフェイスエンドポイント | デュアルスタックのインターフェイスエンドポイント、S3 ゲートウェイエンドポイント `IpAddressType: dualstack`（2025 年 11 月〜） | VPC 関連付けで IPv6 クライアント、IPv4 / IPv6 のターゲットグループ |
| 提供側から呼び出し元が見えるか | ✗（送信元は NLB のアドレス。Proxy Protocol v2 は任意） | 対象外（AWS サービス側は `aws:SourceVpce` を見る） | ✓ `x-amzn-source-vpc`、`x-amzn-lattice-identity`（SigV4） |
| アクセス制御 | エンドポイントの SG、許可するプリンシパル、承諾 | エンドポイントの SG、**エンドポイントポリシー**、リソースポリシー（`aws:SourceVpce`） | 関連付けの SG、**認証ポリシー**（サービスネットワーク + サービス）、SigV4 |
| IPv4 の重複 | 可 | 可 | 可 |
| スピード：追加の遅延（p50 / p99） | *S-1 の結果* | *S-1 の結果* | *S-1 の結果* |
| スピード：新しい接続のコスト | *S-2 の結果* | *S-2 の結果* | *S-2 の結果* |
| スピード：利用者がつながるまで | *S-6 の結果* | *S-6 の結果* | *S-6 の結果* |
| 課金の考え方（料金ページで確認） | エンドポイント × AZ の時間 + GB、別途 NLB | ゲートウェイ：無料 / インターフェイス：AZ ごとの時間 + GB | サービスの時間 + GB + リクエスト数 |

## 仮説（計測前の予想。結果で上書きする）

| ID | 仮説 | シナリオ |
|----|------|----------|
| H1 | PrivateLink の追加遅延がいちばん小さい（L4 の素通し）。Lattice は L7 のホップの分だけ少し増える | S-0、S-1 |
| H2 | 同じ経路なら IPv6 と IPv4 で遅延に意味のある差はない | S-3 |
| H3 | 接続を再利用しない HTTPS のコストのほうが、経路の違いより大きい | S-2 |
| H4 | S3 のゲートウェイとインターフェイスで遅延は同程度。ゲートウェイは無料 | S-1、S-4 |
| H5 | 新しい利用者がつながるのは Lattice（関連付けのみ）がいちばん速い。PrivateLink は提供側の承諾が要る | S-6 |
| H6 | 呼び出し元ごとに提供側が判断できるのは Lattice だけ（SigV4 の識別情報） | X-3、X-4 |
| H7 | バケット側がエンドポイントを許可していても、エンドポイントポリシーで別バケットへの持ち出しを止められる | X-5 |

## スライドに載せる数字

| 数字 | 出どころ | 状況 |
|------|----------|------|
| 経路ごとの p50 / p99（1 KiB、接続の再利用あり） | `results/k6.csv` → `summarize.py --pivot total_p99_ms` | ☐ |
| ハンドシェイクのコスト（接続 + TLS、毎回新しい接続） | S-2 | ☐ |
| IPv6 と IPv4 の差 | S-3 | ☐ |
| 経路ごとの MB/s（1 MiB） | S-4 | ☐ |
| 新しい利用者が呼べるまでの秒数 | S-6 `results/provisioning.csv` | ☐ |
| セキュリティの表（許可 / 拒否） | `results/probe.csv` | ☐ |
| 提供側から見えたもの（送信元 / 識別情報） | `scripts/source-ip-report.sh` | ☐ |
