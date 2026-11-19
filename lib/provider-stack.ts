import * as path from 'node:path';
import {
  CfnOutput,
  IgnoreMode,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_ecr_assets as ecrAssets,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_vpclattice as lattice,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { LabConfig } from './config';
import type { VpcStack } from './vpc-stack';

export interface ProviderStackProps extends StackProps {
  readonly config: LabConfig;
  readonly providerVpc: VpcStack;
  /** The Lattice auth policies allow only this VPC. */
  readonly consumerVpcId: string;
}

/** Link-local ranges VPC Lattice uses to reach targets (same as the managed prefix lists *.vpc-lattice). */
export const LATTICE_IPV4_RANGE = '169.254.171.0/24';
export const LATTICE_IPV6_RANGE = 'fd00:ec2:80::/64';

/**
 * Provider side: ECS cluster, the same netbench task behind
 *   (1) a dual-stack internal NLB + PrivateLink endpoint service  -> svc-pl
 *   (2) VPC Lattice (native ECS integration, IAM auth)              -> svc-lattice
 * plus the baseline k6 task definition and the container images (built by cdkd / cdk as assets).
 */
export class ProviderStack extends Stack {
  readonly endpointServiceName: string;
  readonly serviceNetworkId: string;
  readonly latticeServiceArn: string;
  readonly loadgenImage: ecrAssets.DockerImageAsset;

  constructor(scope: Construct, id: string, props: ProviderStackProps) {
    super(scope, id, props);
    const { config, providerVpc } = props;
    const p = config.prefix;
    const ipv6Targets = config.workloadIpMode === 'ipv6only';
    const projectTag = [{ key: 'Project', value: p }];
    const platform = config.cpuArchitecture === 'ARM64' ? ecrAssets.Platform.LINUX_ARM64 : ecrAssets.Platform.LINUX_AMD64;
    const root = path.join(__dirname, '..');

    // ------------------------------------------------------------ Images (content-hash tags = immutable)
    const netbenchImage = new ecrAssets.DockerImageAsset(this, 'NetbenchImage', {
      directory: path.join(root, 'docker/netbench'),
      platform,
    });
    this.loadgenImage = new ecrAssets.DockerImageAsset(this, 'LoadgenImage', {
      directory: root,
      file: 'docker/loadgen/Dockerfile',
      platform,
      // Only what the Dockerfile copies: keeps node_modules, cdk.out and results out of the build context.
      exclude: ['**', '!docker/loadgen/**', '!scripts/k6-load.js', '!scripts/run-k6.sh', '!scripts/probe-paths.sh'],
      ignoreMode: IgnoreMode.DOCKER,
    });

    // ------------------------------------------------------------ ECS
    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: p,
      clusterSettings: [{ name: 'containerInsights', value: 'enhanced' }],
      tags: projectTag,
    });
    const appLogGroup = new logs.CfnLogGroup(this, 'AppLogGroup', {
      logGroupName: `/${p}/app`,
      retentionInDays: config.logRetentionDays,
    });

    const ecsTasksTrust = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'ecs-tasks.amazonaws.com' },
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'aws:SourceAccount': this.account } },
        },
      ],
    };
    const executionRole = new iam.CfnRole(this, 'TaskExecutionRole', {
      assumeRolePolicyDocument: ecsTasksTrust,
      managedPolicyArns: [`arn:${this.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`],
    });
    // The server does not call AWS APIs: the task role has no permissions on purpose.
    const taskRole = new iam.CfnRole(this, 'TaskRole', { assumeRolePolicyDocument: ecsTasksTrust });
    // ECS registers / deregisters tasks in the VPC Lattice target group with this role.
    const latticeInfraRole = new iam.CfnRole(this, 'EcsLatticeInfrastructureRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ecs.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'aws:SourceAccount': this.account } },
          },
        ],
      },
      managedPolicyArns: [`arn:${this.partition}:iam::aws:policy/AmazonECSInfrastructureRolePolicyForVpcLattice`],
    });

    // ------------------------------------------------------------ Security groups (provider VPC)
    const anyHttpsEgress = [
      { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0', description: 'VPC endpoints (no internet route)' },
      { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIpv6: '::/0', description: 'VPC endpoints (no internet route)' },
    ];
    const nlbSg = new ec2.CfnSecurityGroup(this, 'NlbSg', {
      groupDescription: 'Internal dual-stack NLB (PrivateLink front door)',
      vpcId: providerVpc.vpcId,
      tags: [{ key: 'Name', value: `${p}-provider-nlb` }, ...projectTag],
    });
    const taskSg = new ec2.CfnSecurityGroup(this, 'TaskSg', {
      groupDescription: 'Provider ECS tasks (netbench)',
      vpcId: providerVpc.vpcId,
      securityGroupIngress: [
        { ipProtocol: 'tcp', fromPort: 8080, toPort: 8080, cidrIp: LATTICE_IPV4_RANGE, description: 'VPC Lattice IPv4' },
        { ipProtocol: 'tcp', fromPort: 8080, toPort: 8080, cidrIpv6: LATTICE_IPV6_RANGE, description: 'VPC Lattice IPv6' },
      ],
      securityGroupEgress: anyHttpsEgress,
      tags: [{ key: 'Name', value: `${p}-provider-task` }, ...projectTag],
    });
    // Baseline client inside the provider VPC (k6 as a one-off Fargate task, scenario S-0).
    const baselineSg = new ec2.CfnSecurityGroup(this, 'BaselineSg', {
      groupDescription: 'Baseline load generator task in the provider VPC',
      vpcId: providerVpc.vpcId,
      securityGroupEgress: anyHttpsEgress,
      tags: [{ key: 'Name', value: `${p}-provider-baseline` }, ...projectTag],
    });
    new ec2.CfnSecurityGroupIngress(this, 'NlbIngressFromBaseline', {
      groupId: nlbSg.attrGroupId, ipProtocol: 'tcp', fromPort: 80, toPort: 80,
      sourceSecurityGroupId: baselineSg.attrGroupId, description: 'HTTP from the baseline client',
    });
    new ec2.CfnSecurityGroupEgress(this, 'BaselineEgressToNlb', {
      groupId: baselineSg.attrGroupId, ipProtocol: 'tcp', fromPort: 80, toPort: 80,
      destinationSecurityGroupId: nlbSg.attrGroupId, description: 'HTTP to the NLB',
    });
    new ec2.CfnSecurityGroupEgress(this, 'NlbEgressToTask', {
      groupId: nlbSg.attrGroupId, ipProtocol: 'tcp', fromPort: 8080, toPort: 8080,
      destinationSecurityGroupId: taskSg.attrGroupId, description: 'NLB to tasks (traffic and health checks)',
    });
    new ec2.CfnSecurityGroupIngress(this, 'TaskIngressFromNlb', {
      groupId: taskSg.attrGroupId, ipProtocol: 'tcp', fromPort: 8080, toPort: 8080,
      sourceSecurityGroupId: nlbSg.attrGroupId, description: 'From the NLB (traffic and health checks)',
    });

    // ------------------------------------------------------------ Path 1: dual-stack NLB + PrivateLink endpoint service
    const nlb = new elbv2.CfnLoadBalancer(this, 'Nlb', {
      name: `${p}-nlb`,
      type: 'network',
      scheme: 'internal',
      ipAddressType: 'dualstack',
      subnets: providerVpc.edgeSubnetIds,
      securityGroups: [nlbSg.attrGroupId],
      enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: config.nlbEnforceSgOnPrivateLink,
      loadBalancerAttributes: [{ key: 'load_balancing.cross_zone.enabled', value: 'true' }],
      tags: projectTag,
    });
    // Target family follows the workload subnets: dual-stack tasks register by IPv4, IPv6-only tasks by IPv6.
    const nlbTg = new elbv2.CfnTargetGroup(this, 'NlbTg', {
      name: `${p}-pl`,
      targetType: 'ip',
      protocol: 'TCP',
      port: 8080,
      ipAddressType: ipv6Targets ? 'ipv6' : 'ipv4',
      vpcId: providerVpc.vpcId,
      healthCheckProtocol: 'HTTP',
      healthCheckPath: '/health',
      healthCheckIntervalSeconds: 10,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      targetGroupAttributes: [{ key: 'deregistration_delay.timeout_seconds', value: '30' }],
      tags: projectTag,
    });
    const nlbListener = new elbv2.CfnListener(this, 'NlbListener', {
      loadBalancerArn: nlb.ref,
      port: 80,
      protocol: 'TCP',
      defaultActions: [{ type: 'forward', targetGroupArn: nlbTg.ref }],
    });

    // Security: acceptance required + only this account may connect.
    const endpointService = new ec2.CfnVPCEndpointService(this, 'EndpointService', {
      acceptanceRequired: true,
      networkLoadBalancerArns: [nlb.ref],
      supportedIpAddressTypes: ['ipv4', 'ipv6'],
      tags: projectTag,
    });
    new ec2.CfnVPCEndpointServicePermissions(this, 'EndpointServicePermissions', {
      serviceId: endpointService.ref,
      allowedPrincipals: [`arn:${this.partition}:iam::${this.account}:root`],
    });
    this.endpointServiceName = `com.amazonaws.vpce.${this.region}.${endpointService.ref}`;

    // ------------------------------------------------------------ Path 2: VPC Lattice
    const serviceNetwork = new lattice.CfnServiceNetwork(this, 'ServiceNetwork', {
      name: `${p}-sn`,
      authType: 'AWS_IAM',
      tags: projectTag,
    });
    this.serviceNetworkId = serviceNetwork.attrId;

    const fromConsumerVpc = { 'vpc-lattice-svcs:SourceVpc': props.consumerVpcId };
    // Service network policy: coarse-grained guardrail - only requests coming from the consumer VPC.
    new lattice.CfnAuthPolicy(this, 'ServiceNetworkAuthPolicy', {
      resourceIdentifier: serviceNetwork.ref,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'OnlyFromConsumerVpc',
            Effect: 'Allow',
            Principal: '*',
            Action: 'vpc-lattice-svcs:Invoke',
            Resource: '*',
            Condition: { StringEquals: fromConsumerVpc },
          },
        ],
      },
    });

    const service = new lattice.CfnService(this, 'LatticeService', {
      name: `${p}-netbench`,
      authType: 'AWS_IAM',
      tags: projectTag,
    });
    this.latticeServiceArn = service.attrArn;
    // Service policy: fine-grained. vpc-only allows anonymous callers from the consumer VPC,
    // iam-required additionally needs a SigV4-signed principal of this account.
    new lattice.CfnAuthPolicy(this, 'LatticeServiceAuthPolicy', {
      resourceIdentifier: service.ref,
      policy: {
        Version: '2012-10-17',
        Statement: [
          config.latticeAuthMode === 'iam-required'
            ? {
                Sid: 'SignedCallersOfThisAccountFromConsumerVpc',
                Effect: 'Allow',
                Principal: '*',
                Action: 'vpc-lattice-svcs:Invoke',
                Resource: '*',
                Condition: {
                  StringEquals: { ...fromConsumerVpc, 'aws:PrincipalAccount': this.account },
                  StringNotEqualsIgnoreCase: { 'aws:PrincipalType': 'anonymous' },
                },
              }
            : {
                Sid: 'AnyCallerFromConsumerVpc',
                Effect: 'Allow',
                Principal: '*',
                Action: 'vpc-lattice-svcs:Invoke',
                Resource: '*',
                Condition: { StringEquals: fromConsumerVpc },
              },
        ],
      },
    });

    const latticeTg = new lattice.CfnTargetGroup(this, 'LatticeTg', {
      name: `${p}-lattice`,
      type: 'IP',
      config: {
        port: 8080,
        protocol: 'HTTP',
        protocolVersion: 'HTTP1',
        ipAddressType: ipv6Targets ? 'IPV6' : 'IPV4',
        vpcIdentifier: providerVpc.vpcId,
        healthCheck: {
          enabled: true,
          protocol: 'HTTP',
          path: '/health',
          healthCheckIntervalSeconds: 10,
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 2,
        },
      },
      tags: projectTag,
    });
    const forward = { forward: { targetGroups: [{ targetGroupIdentifier: latticeTg.ref, weight: 100 }] } };
    // HTTP listener: apples-to-apples with the PrivateLink path (plain TCP/HTTP).
    new lattice.CfnListener(this, 'LatticeHttpListener', {
      serviceIdentifier: service.ref, name: 'http', protocol: 'HTTP', port: 80, defaultAction: forward,
    });
    // HTTPS listener with the AWS-provided certificate of the generated *.on.aws name.
    new lattice.CfnListener(this, 'LatticeHttpsListener', {
      serviceIdentifier: service.ref, name: 'https', protocol: 'HTTPS', port: 443, defaultAction: forward,
    });
    new lattice.CfnServiceNetworkServiceAssociation(this, 'ServiceNetworkServiceAssociation', {
      serviceNetworkIdentifier: serviceNetwork.ref,
      serviceIdentifier: service.ref,
    });
    // Access logs show auth decisions, source VPC, caller principal and target latency.
    const latticeLogGroup = new logs.CfnLogGroup(this, 'LatticeAccessLogGroup', {
      logGroupName: `/aws/vendedlogs/${p}/lattice`,
      retentionInDays: config.logRetentionDays,
    });
    new lattice.CfnAccessLogSubscription(this, 'LatticeAccessLogs', {
      resourceIdentifier: serviceNetwork.ref,
      destinationArn: latticeLogGroup.attrArn,
    });

    // ------------------------------------------------------------ Services: same task definition behind both paths
    const awslogs = (streamPrefix: string) => ({
      logDriver: 'awslogs',
      options: { 'awslogs-group': appLogGroup.ref, 'awslogs-region': this.region, 'awslogs-stream-prefix': streamPrefix },
    });
    const hardening = {
      readonlyRootFilesystem: true,
      linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
    };
    const runtimePlatform = { operatingSystemFamily: 'LINUX', cpuArchitecture: config.cpuArchitecture };

    const netbenchTd = new ecs.CfnTaskDefinition(this, 'NetbenchTaskDef', {
      family: `${p}-netbench`,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: config.taskCpu,
      memory: config.taskMemory,
      runtimePlatform,
      executionRoleArn: executionRole.attrArn,
      taskRoleArn: taskRole.attrArn,
      volumes: [{ name: 'web-tmp' }],
      containerDefinitions: [
        {
          name: 'web',
          image: netbenchImage.imageUri,
          essential: true,
          ...hardening,
          // The port name is what VPC Lattice uses to find the container port.
          portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp', appProtocol: 'http' }],
          mountPoints: [{ sourceVolume: 'web-tmp', containerPath: '/tmp' }],
          logConfiguration: awslogs('netbench'),
        },
      ],
      tags: projectTag,
    });

    const serviceBase = (pathTag: string) => ({
      cluster: cluster.ref,
      taskDefinition: netbenchTd.ref,
      desiredCount: config.desiredCount,
      launchType: 'FARGATE',
      platformVersion: 'LATEST',
      enableExecuteCommand: false,
      propagateTags: 'SERVICE',
      deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } },
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'DISABLED',
          subnets: providerVpc.workloadSubnetIds,
          securityGroups: [taskSg.attrGroupId],
        },
      },
      tags: [...projectTag, { key: 'Path', value: pathTag }],
    });
    // consumer -> interface endpoint -> PrivateLink -> NLB -> task
    const svcPl = new ecs.CfnService(this, 'SvcPrivateLink', {
      serviceName: 'svc-pl',
      ...serviceBase('privatelink'),
      loadBalancers: [{ containerName: 'web', containerPort: 8080, targetGroupArn: nlbTg.ref }],
    });
    svcPl.addResourceDependency(nlbListener);
    // consumer -> service network association -> VPC Lattice -> task (no load balancer)
    new ecs.CfnService(this, 'SvcLattice', {
      serviceName: 'svc-lattice',
      ...serviceBase('lattice'),
      vpcLatticeConfigurations: [{ roleArn: latticeInfraRole.attrArn, targetGroupArn: latticeTg.attrArn, portName: 'http' }],
    });

    // Scenario S-0: k6 inside the provider VPC, straight to the NLB. Run with scripts/run-baseline.sh.
    const baselineTd = new ecs.CfnTaskDefinition(this, 'BaselineTaskDef', {
      family: `${p}-baseline`,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '1024',
      memory: '2048',
      runtimePlatform,
      executionRoleArn: executionRole.attrArn,
      taskRoleArn: taskRole.attrArn,
      volumes: [{ name: 'k6-tmp' }, { name: 'k6-scratch' }],
      containerDefinitions: [
        {
          name: 'k6',
          image: this.loadgenImage.imageUri,
          essential: true,
          ...hardening,
          // /tmp alone is not enough: a Fargate bind mount is root:0755, so the non-root k6 user cannot
          // write results there. /work/scratch exists in the image owned by that user (see the Dockerfile).
          mountPoints: [
            { sourceVolume: 'k6-tmp', containerPath: '/tmp' },
            { sourceVolume: 'k6-scratch', containerPath: '/work/scratch' },
          ],
          logConfiguration: awslogs('baseline'),
        },
      ],
      tags: projectTag,
    });

    // ------------------------------------------------------------ Outputs (read by scripts/ from cdk-outputs.json)
    const outputs: Record<string, string> = {
      ClusterName: cluster.ref,
      AppLogGroupName: appLogGroup.ref,
      LatticeAccessLogGroupName: latticeLogGroup.ref,
      NlbDnsName: nlb.attrDnsName,
      EndpointServiceId: endpointService.ref,
      EndpointServiceName: this.endpointServiceName,
      ServiceNetworkId: serviceNetwork.attrId,
      LatticeServiceArn: service.attrArn,
      LatticeServiceDns: service.attrDnsEntryDomainName,
      LatticeTgArn: latticeTg.attrArn,
      BaselineTaskDefArn: baselineTd.ref,
      BaselineSg: baselineSg.attrGroupId,
      NetbenchImageUri: netbenchImage.imageUri,
      LoadgenImageUri: this.loadgenImage.imageUri,
    };
    for (const [k, v] of Object.entries(outputs)) new CfnOutput(this, `Out${k}`, { key: k, value: v });
  }
}
