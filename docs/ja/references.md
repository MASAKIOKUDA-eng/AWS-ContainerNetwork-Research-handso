# 参考資料

[English](../en/references.md)

機能も料金も変わるため、ハンズオンを実施する日に確認してください。リンク先は英語版の参考資料と同じです（日本語ページがあるものは URL の `/` 直後に `jp/` や `ja_jp/` を入れると日本語で読めます）。

## この登壇のために共有された資料

- JAWS-UG 山梨のイベントページ：https://jaws-ug-yamanashi.connpass.com/event/411061/
- AWS ブログ：AWS で IPv6 のインターネット検査アーキテクチャを設計・構築する — https://aws.amazon.com/jp/blogs/news/design-and-build-ipv6-internet-inspection-architectures-on-aws/
- AWS Summit Japan 2024 ネットワークセッション資料（AWS-20）：https://pages.awscloud.com/rs/112-TZM-766/images/AWS-20_Network_AWS_Summit_JP_2024.pdf
- 作者の関連ハンズオン：ECS ネットワークモード比較 — https://github.com/MASAKIOKUDA-eng/aws-ecs-nw-mode-handson

## AWS の IPv6

- IPv6 on AWS（ホワイトペーパー）：https://docs.aws.amazon.com/whitepapers/latest/ipv6-on-aws/IPv6-on-AWS.html
- VPC の IP アドレス：https://docs.aws.amazon.com/vpc/latest/userguide/vpc-ip-addressing.html
- DNS64 と NAT64：https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-nat64-dns64.html
- パブリック IPv4 アドレスの課金（2024 年 2 月）：https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/

## Amazon ECS

- ECS の IPv6 のみ対応（2025 年 9 月）：https://aws.amazon.com/jp/about-aws/whats-new/2025/09/amazon-ecs-ipv6-only-support/
- ブログ：https://aws.amazon.com/jp/blogs/containers/amazon-ecs-announces-ipv6-only-support/
- Fargate のタスクネットワーク：https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/fargate-task-networking.html
- ECS と VPC Lattice：https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-vpc-lattice.html

## AWS PrivateLink / VPC エンドポイント

- AWS PrivateLink の概念：https://docs.aws.amazon.com/vpc/latest/privatelink/concepts.html
- エンドポイントサービス（IP アドレスタイプ、承諾）：https://docs.aws.amazon.com/vpc/latest/privatelink/create-endpoint-service.html
- ゲートウェイエンドポイント：https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- S3 のゲートウェイ / インターフェイスエンドポイントの IPv6 対応（2025 年 11 月）：https://aws.amazon.com/about-aws/whats-new/2025/11/ipv6-amazon-s3-gateway-interface-vpc-endpoints
- エンドポイントポリシー：https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-access.html
- NLB のセキュリティグループと PrivateLink：https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-security-groups.html
- PrivateLink の料金：https://aws.amazon.com/jp/privatelink/pricing/

## Amazon VPC Lattice

- VPC Lattice とは：https://docs.aws.amazon.com/vpc-lattice/latest/ug/what-is-vpc-lattice.html
- ターゲットグループ（IPv4 / IPv6）：https://docs.aws.amazon.com/ja_jp/vpc-lattice/latest/ug/target-groups.html
- 認証ポリシー：https://docs.aws.amazon.com/vpc-lattice/latest/ug/auth-policies.html
- アクセスログ：https://docs.aws.amazon.com/vpc-lattice/latest/ug/monitoring-access-logs.html
- セキュリティグループ（関連付け、マネージドプレフィックスリスト）：https://docs.aws.amazon.com/vpc-lattice/latest/ug/security-groups.html
- ブログ：Accelerate your IPv6 adoption on AWS with Amazon VPC Lattice — https://aws.amazon.com/blogs/networking-and-content-delivery/accelerate-your-ipv6-adoption-on-aws-with-amazon-vpc-lattice
- 料金：https://aws.amazon.com/jp/vpc/lattice/pricing/

## ツール

- cdkd（CDK Direct）：https://github.com/go-to-k/cdkd / https://cdkd.dev
- AWS CDK：https://docs.aws.amazon.com/cdk/v2/guide/home.html

- k6 のオプション（DNS のポリシー、接続の再利用）：https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/
- curl の `--aws-sigv4`：https://curl.se/docs/manpage.html#--aws-sigv4
