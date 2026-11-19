import { CfnOutput, Fn, Stack, type StackProps, aws_ec2 as ec2, aws_iam as iam, aws_logs as logs } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { LabConfig } from './config';

export interface VpcStackProps extends StackProps {
  readonly config: LabConfig;
  readonly role: 'consumer' | 'provider';
  /** Keep the same value for both VPCs to prove that PrivateLink / VPC Lattice do not care about overlapping IPv4. */
  readonly ipv4Cidr?: string;
}

/**
 * Private-only dual-stack VPC (no IGW / NAT / EIGW). Deployed twice: consumer and provider.
 *
 * Subnet plan  IPv4 /20 x 4 and IPv6 /64 x 4, in this order:
 *   edge-a, edge-b         always dual-stack  (NLB, VPC endpoints)
 *   workload-a, workload-b dual-stack or IPv6-only (ECS tasks, load generator)
 */
export class VpcStack extends Stack {
  readonly vpcId: string;
  readonly ipv4Cidr: string;
  readonly ipv6Cidr: string;
  readonly edgeSubnetIds: string[];
  readonly workloadSubnetIds: string[];
  readonly s3GatewayEndpointId: string;

  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);
    const { config, role } = props;
    const p = config.prefix;
    const ipv6Only = config.workloadIpMode === 'ipv6only';
    const tags = (name: string) => [
      { key: 'Name', value: name },
      { key: 'Project', value: p },
    ];
    this.ipv4Cidr = props.ipv4Cidr ?? '10.0.0.0/16';

    // ------------------------------------------------------------ VPC (IPv4 + Amazon-provided IPv6 /56)
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: this.ipv4Cidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: tags(`${p}-${role}`),
    });
    const ipv6Block = new ec2.CfnVPCCidrBlock(this, 'VpcIpv6Cidr', {
      vpcId: vpc.ref,
      amazonProvidedIpv6CidrBlock: true,
    });
    this.vpcId = vpc.ref;
    this.ipv6Cidr = Fn.select(0, vpc.attrIpv6CidrBlocks);

    const v4 = (i: number) => Fn.select(i, Fn.cidr(this.ipv4Cidr, 4, '12'));
    const v6 = (i: number) => Fn.select(i, Fn.cidr(this.ipv6Cidr, 4, '64'));
    const az = (i: number) => Fn.select(i, Fn.getAzs(''));

    const subnet = (logicalId: string, index: number, azIndex: number, name: string, workload: boolean) => {
      const native = workload && ipv6Only;
      const s = new ec2.CfnSubnet(this, logicalId, {
        vpcId: vpc.ref,
        availabilityZone: az(azIndex),
        cidrBlock: native ? undefined : v4(index),
        ipv6CidrBlock: v6(index),
        ipv6Native: native,
        assignIpv6AddressOnCreation: true,
        mapPublicIpOnLaunch: false,
        privateDnsNameOptionsOnLaunch: {
          HostnameType: 'resource-name',
          EnableResourceNameDnsAAAARecord: true,
          EnableResourceNameDnsARecord: !native,
        },
        tags: tags(`${p}-${role}-${name}`),
      });
      s.addResourceDependency(ipv6Block);
      return s;
    };
    const edgeA = subnet('EdgeSubnetA', 0, 0, 'edge-a', false);
    const edgeB = subnet('EdgeSubnetB', 1, 1, 'edge-b', false);
    const workA = subnet('WorkloadSubnetA', 2, 0, 'workload-a', true);
    const workB = subnet('WorkloadSubnetB', 3, 1, 'workload-b', true);
    this.edgeSubnetIds = [edgeA.ref, edgeB.ref];
    this.workloadSubnetIds = [workA.ref, workB.ref];

    // One route table with local routes only: no 0.0.0.0/0 and no ::/0.
    const rt = new ec2.CfnRouteTable(this, 'PrivateRouteTable', { vpcId: vpc.ref, tags: tags(`${p}-${role}-private`) });
    for (const [s, logicalId] of [[edgeA, 'EdgeSubnetARt'], [edgeB, 'EdgeSubnetBRt'], [workA, 'WorkloadSubnetARt'], [workB, 'WorkloadSubnetBRt']] as const) {
      new ec2.CfnSubnetRouteTableAssociation(this, logicalId, { subnetId: s.ref, routeTableId: rt.ref });
    }

    // ------------------------------------------------------------ SG for AWS service endpoints (HTTPS from this VPC only)
    const endpointSg = new ec2.CfnSecurityGroup(this, 'AwsEndpointSg', {
      groupDescription: 'Interface endpoints for AWS services (HTTPS from this VPC only)',
      vpcId: vpc.ref,
      securityGroupIngress: [
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: this.ipv4Cidr, description: 'HTTPS from VPC IPv4' },
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIpv6: this.ipv6Cidr, description: 'HTTPS from VPC IPv6' },
      ],
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '127.0.0.1/32', description: 'No egress' }],
      tags: tags(`${p}-${role}-aws-endpoints`),
    });
    // The IPv6 ingress rule reads Vpc.Ipv6CidrBlocks, which is empty until the /56 is associated.
    endpointSg.addResourceDependency(ipv6Block);

    // ------------------------------------------------------------ VPC endpoints for AWS services
    // Dual-stack interface endpoints answer AAAA from the VPC resolver, so IPv6-only tasks can use them.
    const services: [string, string][] = [
      ['ecr.api', 'EcrApiEndpoint'],
      ['ecr.dkr', 'EcrDkrEndpoint'],
      ['logs', 'LogsEndpoint'],
      // Consumer only: Session Manager for the load generator EC2 (no SSH, no bastion).
      ...(role === 'consumer'
        ? ([
            ['ssm', 'SsmEndpoint'],
            ['ssmmessages', 'SsmMessagesEndpoint'],
            ['ec2messages', 'Ec2MessagesEndpoint'],
          ] as [string, string][])
        : []),
    ];
    for (const [svc, logicalId] of services) {
      new ec2.CfnVPCEndpoint(this, logicalId, {
        vpcId: vpc.ref,
        serviceName: `com.amazonaws.${this.region}.${svc}`,
        vpcEndpointType: 'Interface',
        privateDnsEnabled: true,
        ipAddressType: config.endpointIpAddressType,
        dnsOptions: { dnsRecordIpType: config.endpointIpAddressType },
        subnetIds: this.edgeSubnetIds,
        securityGroupIds: [endpointSg.ref],
      });
    }

    // S3 gateway endpoint (free). The endpoint policy is a data perimeter:
    // only the buckets this lab needs are reachable through it, read-only.
    const statements: Record<string, unknown>[] = [
      {
        Sid: 'EcrImageLayers',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:${this.partition}:s3:::prod-${this.region}-starport-layer-bucket/*`,
      },
      {
        Sid: 'AmazonLinux2023Repos',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:${this.partition}:s3:::al2023-repos-${this.region}-*/*`,
      },
    ];
    if (role === 'consumer') {
      statements.push({
        Sid: 'LabDataBucketOnly',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:${this.partition}:s3:::${p}-data-${this.account}/*`,
      });
    }
    const s3Gateway = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      vpcId: vpc.ref,
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcEndpointType: 'Gateway',
      ipAddressType: config.s3GatewayIpAddressType,
      routeTableIds: [rt.ref],
      policyDocument: { Version: '2012-10-17', Statement: statements },
    });
    this.s3GatewayEndpointId = s3Gateway.ref;

    // ------------------------------------------------------------ VPC Flow Logs
    // traffic-path / pkt-*addr / flow-direction show which path (and which IP family) a flow used.
    const flowLogGroup = new logs.CfnLogGroup(this, 'FlowLogGroup', {
      logGroupName: `/${p}/${role}/vpc-flow-logs`,
      retentionInDays: config.logRetentionDays,
    });
    const flowLogRole = new iam.CfnRole(this, 'FlowLogRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'vpc-flow-logs.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'aws:SourceAccount': this.account } },
          },
        ],
      },
      policies: [
        {
          policyName: 'write-flow-logs',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
                Resource: flowLogGroup.attrArn,
              },
            ],
          },
        },
      ],
    });
    new ec2.CfnFlowLog(this, 'FlowLog', {
      resourceId: vpc.ref,
      resourceType: 'VPC',
      trafficType: 'ALL',
      logDestinationType: 'cloud-watch-logs',
      logGroupName: flowLogGroup.ref,
      deliverLogsPermissionArn: flowLogRole.attrArn,
      maxAggregationInterval: 60,
      logFormat: [
        '${version} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport}',
        '${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}',
        '${pkt-srcaddr} ${pkt-dstaddr} ${flow-direction} ${traffic-path} ${az-id}',
        '${ecs-service-name} ${ecs-task-id}',
      ].join(' '),
      tags: [{ key: 'Project', value: p }],
    });

    new CfnOutput(this, 'OutVpcId', { key: 'VpcId', value: vpc.ref });
    new CfnOutput(this, 'OutVpcIpv6Cidr', { key: 'VpcIpv6Cidr', value: this.ipv6Cidr });
    new CfnOutput(this, 'OutWorkloadSubnetA', { key: 'WorkloadSubnetA', value: workA.ref });
    new CfnOutput(this, 'OutS3GatewayEndpointId', { key: 'S3GatewayEndpointId', value: s3Gateway.ref });
    new CfnOutput(this, 'OutFlowLogGroupName', { key: 'FlowLogGroupName', value: flowLogGroup.ref });
  }
}
