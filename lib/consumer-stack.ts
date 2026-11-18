import {
  CfnOutput,
  Fn,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_s3 as s3,
  aws_vpclattice as lattice,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { LabConfig } from './config';
import type { ProviderStack } from './provider-stack';
import type { VpcStack } from './vpc-stack';

export interface ConsumerStackProps extends StackProps {
  readonly config: LabConfig;
  readonly consumerVpc: VpcStack;
  readonly provider: ProviderStack;
}

/**
 * Consumer side: load generator EC2 (SSM only), PrivateLink interface endpoint (dual-stack),
 * VPC Lattice service network association (with SG), S3 data buckets + S3 interface endpoint.
 */
export class ConsumerStack extends Stack {
  constructor(scope: Construct, id: string, props: ConsumerStackProps) {
    super(scope, id, props);
    const { config, consumerVpc, provider } = props;
    const p = config.prefix;
    const vpcId = consumerVpc.vpcId;
    const projectTag = [{ key: 'Project', value: p }];
    const named = (name: string) => [{ key: 'Name', value: name }, ...projectTag];
    const noEgress = [{ ipProtocol: '-1', cidrIp: '127.0.0.1/32', description: 'No egress' }];

    // ------------------------------------------------------------ Security groups (consumer VPC)
    // TrustedClientSg  : the load generator normally uses this one.
    // UntrustedClientSg: swap it onto the load generator for the "denied" security tests (X-1).
    // Both may reach the AWS service endpoints (443) so Session Manager keeps working.
    const clientEgress = [80, 443].flatMap((port) => [
      { ipProtocol: 'tcp', fromPort: port, toPort: port, cidrIp: '0.0.0.0/0', description: `TCP ${port} (no internet route)` },
      { ipProtocol: 'tcp', fromPort: port, toPort: port, cidrIpv6: '::/0', description: `TCP ${port} (no internet route)` },
    ]);
    const trustedSg = new ec2.CfnSecurityGroup(this, 'TrustedClientSg', {
      groupDescription: 'Load generator - trusted client',
      vpcId,
      securityGroupEgress: clientEgress,
      tags: named(`${p}-consumer-trusted`),
    });
    const untrustedSg = new ec2.CfnSecurityGroup(this, 'UntrustedClientSg', {
      groupDescription: 'Load generator - untrusted client (security tests)',
      vpcId,
      securityGroupEgress: clientEgress,
      tags: named(`${p}-consumer-untrusted`),
    });
    const fromTrusted = (port: number, what: string) => ({
      ipProtocol: 'tcp', fromPort: port, toPort: port, sourceSecurityGroupId: trustedSg.attrGroupId, description: `${what} from trusted clients`,
    });
    const plEndpointSg = new ec2.CfnSecurityGroup(this, 'PrivateLinkEndpointSg', {
      groupDescription: 'PrivateLink interface endpoint - trusted clients only',
      vpcId,
      securityGroupIngress: [fromTrusted(80, 'HTTP')],
      securityGroupEgress: noEgress,
      tags: named(`${p}-consumer-pl-endpoint`),
    });
    const latticeAssocSg = new ec2.CfnSecurityGroup(this, 'LatticeAssociationSg', {
      groupDescription: 'VPC Lattice service network association - trusted clients only',
      vpcId,
      securityGroupIngress: [fromTrusted(80, 'HTTP'), fromTrusted(443, 'HTTPS')],
      securityGroupEgress: noEgress,
      tags: named(`${p}-consumer-lattice-assoc`),
    });
    const s3EndpointSg = new ec2.CfnSecurityGroup(this, 'S3InterfaceEndpointSg', {
      groupDescription: 'S3 interface endpoint - trusted clients only',
      vpcId,
      securityGroupIngress: [fromTrusted(443, 'HTTPS')],
      securityGroupEgress: noEgress,
      tags: named(`${p}-consumer-s3-endpoint`),
    });

    // ------------------------------------------------------------ Path 1: PrivateLink interface endpoint (dual-stack)
    // The connection stays "pendingAcceptance" until the provider accepts it (scripts/accept-endpoint.sh).
    const plEndpoint = new ec2.CfnVPCEndpoint(this, 'PrivateLinkEndpoint', {
      vpcId,
      serviceName: provider.endpointServiceName,
      vpcEndpointType: 'Interface',
      privateDnsEnabled: false,
      ipAddressType: 'dualstack',
      dnsOptions: { dnsRecordIpType: 'dualstack' },
      subnetIds: consumerVpc.edgeSubnetIds,
      securityGroupIds: [plEndpointSg.attrGroupId],
    });

    // ------------------------------------------------------------ Path 2: VPC Lattice service network association
    const association = new lattice.CfnServiceNetworkVpcAssociation(this, 'LatticeAssociation', {
      serviceNetworkIdentifier: provider.serviceNetworkId,
      vpcIdentifier: vpcId,
      securityGroupIds: [latticeAssocSg.attrGroupId],
      tags: projectTag,
    });

    // ------------------------------------------------------------ Path 3: VPC endpoints for AWS services (S3)
    // DataBucket   : readable ONLY through this VPC's S3 endpoints (bucket policy = resource perimeter).
    // OutsideBucket: same bucket policy, but NOT listed in the endpoint policies (network perimeter test).
    const bucket = (logicalId: string, name: string) =>
      new s3.CfnBucket(this, logicalId, {
        bucketName: name,
        publicAccessBlockConfiguration: {
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        },
        ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
        bucketEncryption: { serverSideEncryptionConfiguration: [{ serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }] },
        tags: projectTag,
      });
    const dataBucket = bucket('DataBucket', `${p}-data-${this.account}`);
    const outsideBucket = bucket('OutsideBucket', `${p}-outside-${this.account}`);

    const s3Endpoint = new ec2.CfnVPCEndpoint(this, 'S3InterfaceEndpoint', {
      vpcId,
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcEndpointType: 'Interface',
      // Keep the gateway endpoint as the default S3 path; use the vpce-specific name for this one.
      privateDnsEnabled: false,
      ipAddressType: 'dualstack',
      dnsOptions: { dnsRecordIpType: 'dualstack' },
      subnetIds: consumerVpc.edgeSubnetIds,
      securityGroupIds: [s3EndpointSg.attrGroupId],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Sid: 'LabDataBucketOnly', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `${dataBucket.attrArn}/*` },
        ],
      },
    });

    // Anonymous GET is allowed only when the request arrives through one of the two endpoints.
    // S3 does not treat a policy restricted by aws:SourceVpce as public, so Block Public Access stays on.
    // Writes from outside (CloudShell, IAM principal) still work for uploading the test objects.
    const perimeterPolicy = (logicalId: string, b: s3.CfnBucket) =>
      new s3.CfnBucketPolicy(this, logicalId, {
        bucket: b.ref,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'ReadOnlyThroughConsumerEndpoints',
              Effect: 'Allow',
              Principal: '*',
              Action: 's3:GetObject',
              Resource: `${b.attrArn}/*`,
              Condition: { StringEquals: { 'aws:SourceVpce': [consumerVpc.s3GatewayEndpointId, s3Endpoint.ref] } },
            },
            {
              Sid: 'DenyInsecureTransport',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [b.attrArn, `${b.attrArn}/*`],
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            },
          ],
        },
      });
    perimeterPolicy('DataBucketPolicy', dataBucket);
    perimeterPolicy('OutsideBucketPolicy', outsideBucket);

    // ------------------------------------------------------------ Load generator EC2 (SSM only, no inbound)
    const loadgenRole = new iam.CfnRole(this, 'LoadgenRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      managedPolicyArns: [`arn:${this.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`],
      policies: [
        {
          policyName: 'loadgen',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
              {
                // Container assets live in the cdkd asset repo (cdkd deploy) or the CDK bootstrap repo (cdk deploy).
                Sid: 'PullLoadgenImage',
                Effect: 'Allow',
                Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
                Resource: [
                  `arn:${this.partition}:ecr:${this.region}:${this.account}:repository/cdkd-container-assets-${this.account}-${this.region}`,
                  `arn:${this.partition}:ecr:${this.region}:${this.account}:repository/cdk-*-container-assets-${this.account}-${this.region}`,
                ],
              },
              {
                // Used only by the SigV4 test (X-3) against the Lattice service.
                Sid: 'InvokeLatticeService',
                Effect: 'Allow',
                Action: 'vpc-lattice-svcs:Invoke',
                Resource: `${provider.latticeServiceArn}/*`,
              },
            ],
          },
        },
      ],
    });
    const profile = new iam.CfnInstanceProfile(this, 'LoadgenInstanceProfile', { roles: [loadgenRole.ref] });

    const ami = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: config.cpuArchitecture === 'ARM64' ? ec2.AmazonLinuxCpuType.ARM_64 : ec2.AmazonLinuxCpuType.X86_64,
    }).getImage(this).imageId;

    const loadgen = new ec2.CfnInstance(this, 'Loadgen', {
      imageId: ami,
      instanceType: config.loadgenInstanceType,
      iamInstanceProfile: profile.ref,
      subnetId: consumerVpc.workloadSubnetIds[0],
      securityGroupIds: [trustedSg.attrGroupId],
      metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1, httpEndpoint: 'enabled', httpProtocolIpv6: 'enabled' },
      blockDeviceMappings: [
        { deviceName: '/dev/xvda', ebs: { volumeSize: 30, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } },
      ],
      // Amazon Linux 2023 repositories are reachable through the S3 gateway endpoint.
      userData: Fn.base64(['#!/bin/bash', 'dnf install -y docker jq bind-utils', 'systemctl enable --now docker', ''].join('\n')),
      tags: named(`${p}-loadgen`),
    });

    // ------------------------------------------------------------ Outputs (read by scripts/ from cdk-outputs.json)
    const dnsOf = (ep: ec2.CfnVPCEndpoint) => Fn.select(1, Fn.split(':', Fn.select(0, ep.attrDnsEntries)));
    const outputs: Record<string, string> = {
      LoadgenInstanceId: loadgen.ref,
      TrustedClientSg: trustedSg.attrGroupId,
      UntrustedClientSg: untrustedSg.attrGroupId,
      PrivateLinkEndpointId: plEndpoint.ref,
      // Regional DNS name of the interface endpoint (answers A and AAAA)
      PrivateLinkEndpointDns: dnsOf(plEndpoint),
      S3InterfaceEndpointId: s3Endpoint.ref,
      // *.vpce-xxx.s3.<region>.vpce.amazonaws.com - replace * with 'bucket'
      S3InterfaceEndpointDns: dnsOf(s3Endpoint),
      DataBucketName: dataBucket.ref,
      OutsideBucketName: outsideBucket.ref,
      LatticeAssociationId: association.attrId,
    };
    for (const [k, v] of Object.entries(outputs)) new CfnOutput(this, `Out${k}`, { key: k, value: v });
  }
}
