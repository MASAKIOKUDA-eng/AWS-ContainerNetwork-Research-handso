# References

[日本語](../ja/references.md)

Check these on the day you run the lab — features and prices change.

## Given for this talk

- JAWS-UG Yamanashi event page: https://jaws-ug-yamanashi.connpass.com/event/411061/
- AWS blog (JP): Design and build IPv6 internet inspection architectures on AWS — https://aws.amazon.com/jp/blogs/news/design-and-build-ipv6-internet-inspection-architectures-on-aws/
- AWS Summit Japan 2024, network session deck (AWS-20): https://pages.awscloud.com/rs/112-TZM-766/images/AWS-20_Network_AWS_Summit_JP_2024.pdf
- Related labs by the author: ECS network mode comparison — https://github.com/MASAKIOKUDA-eng/aws-ecs-nw-mode-handson

## IPv6 on AWS

- IPv6 on AWS (whitepaper): https://docs.aws.amazon.com/whitepapers/latest/ipv6-on-aws/IPv6-on-AWS.html
- VPC IPv6 support: https://docs.aws.amazon.com/vpc/latest/userguide/vpc-ip-addressing.html
- DNS64 and NAT64: https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-nat64-dns64.html
- Public IPv4 address charge (Feb 2024): https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/

## Amazon ECS

- Amazon ECS announces IPv6-only support (Sep 2025): https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-ecs-ipv6-only-support
- Blog: https://aws.amazon.com/blogs/containers/amazon-ecs-announces-ipv6-only-support
- Fargate task networking: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html
- ECS with VPC Lattice: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-vpc-lattice.html

## AWS PrivateLink / VPC endpoints

- AWS PrivateLink concepts: https://docs.aws.amazon.com/vpc/latest/privatelink/concepts.html
- Endpoint services (IP address types, acceptance): https://docs.aws.amazon.com/vpc/latest/privatelink/create-endpoint-service.html
- Gateway endpoints: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- S3 IPv6 for gateway and interface endpoints (Nov 2025): https://aws.amazon.com/about-aws/whats-new/2025/11/ipv6-amazon-s3-gateway-interface-vpc-endpoints
- Endpoint policies: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-access.html
- NLB security groups and PrivateLink: https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-security-groups.html
- PrivateLink pricing: https://aws.amazon.com/privatelink/pricing/

## Amazon VPC Lattice

- What is VPC Lattice: https://docs.aws.amazon.com/vpc-lattice/latest/ug/what-is-vpc-lattice.html
- Target groups (IPv4 / IPv6): https://docs.aws.amazon.com/vpc-lattice/latest/ug/target-groups.html
- Auth policies: https://docs.aws.amazon.com/vpc-lattice/latest/ug/auth-policies.html
- Access logs: https://docs.aws.amazon.com/vpc-lattice/latest/ug/monitoring-access-logs.html
- Security groups (association, managed prefix lists): https://docs.aws.amazon.com/vpc-lattice/latest/ug/security-groups.html
- Blog: Accelerate your IPv6 adoption on AWS with Amazon VPC Lattice — https://aws.amazon.com/blogs/networking-and-content-delivery/accelerate-your-ipv6-adoption-on-aws-with-amazon-vpc-lattice
- Pricing: https://aws.amazon.com/vpc/lattice/pricing/

## Tools

- cdkd (CDK Direct): https://github.com/go-to-k/cdkd / https://cdkd.dev
- AWS CDK: https://docs.aws.amazon.com/cdk/v2/guide/home.html

- k6 options (DNS policy, connection reuse): https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/
- curl `--aws-sigv4`: https://curl.se/docs/manpage.html#--aws-sigv4
