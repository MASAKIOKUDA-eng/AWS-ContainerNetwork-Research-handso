/**
 * Security and IPv6 invariants of the lab, checked on the synthesized templates.
 * Runs without AWS credentials (no deploy): npm test
 */
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config';
import { ConsumerStack } from '../lib/consumer-stack';
import { ProviderStack } from '../lib/provider-stack';
import { VpcStack } from '../lib/vpc-stack';

function synth(context: Record<string, unknown> = {}) {
  const app = new App({ context: { prefix: 'v6lab', ...context } });
  const config = loadConfig(app);
  const env = { account: '123456789012', region: 'ap-northeast-1' };
  const consumerVpc = new VpcStack(app, 'cvpc', { env, config, role: 'consumer' });
  const providerVpc = new VpcStack(app, 'pvpc', { env, config, role: 'provider' });
  const provider = new ProviderStack(app, 'prov', { env, config, providerVpc, consumerVpcId: consumerVpc.vpcId });
  const consumer = new ConsumerStack(app, 'cons', { env, config, consumerVpc, provider });
  const t = {
    consumerVpc: Template.fromStack(consumerVpc),
    providerVpc: Template.fromStack(providerVpc),
    provider: Template.fromStack(provider),
    consumer: Template.fromStack(consumer),
  };
  return { ...t, all: Object.values(t) };
}

const dual = synth();

describe('no internet path (design decision D1)', () => {
  it.each(['AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway', 'AWS::EC2::EgressOnlyInternetGateway', 'AWS::EC2::EIP'])(
    'has no %s',
    (type) => {
      for (const t of dual.all) t.resourceCountIs(type, 0);
    },
  );
  it('route tables have no routes besides local ones', () => {
    for (const t of dual.all) t.resourceCountIs('AWS::EC2::Route', 0);
  });
  it('no public IPs on subnets, NLB is internal', () => {
    for (const t of [dual.consumerVpc, dual.providerVpc]) {
      t.allResourcesProperties('AWS::EC2::Subnet', { MapPublicIpOnLaunch: false });
    }
    dual.provider.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    dual.provider.allResourcesProperties('AWS::ECS::Service', {
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } },
    });
  });
});

describe('security groups', () => {
  it('no ingress from 0.0.0.0/0 or ::/0 anywhere', () => {
    for (const t of dual.all) {
      for (const sg of Object.values(t.findResources('AWS::EC2::SecurityGroup'))) {
        for (const rule of sg.Properties.SecurityGroupIngress ?? []) {
          expect(rule.CidrIp).not.toBe('0.0.0.0/0');
          expect(rule.CidrIpv6).not.toBe('::/0');
        }
      }
      for (const r of Object.values(t.findResources('AWS::EC2::SecurityGroupIngress'))) {
        expect(r.Properties.CidrIp).not.toBe('0.0.0.0/0');
        expect(r.Properties.CidrIpv6).not.toBe('::/0');
      }
    }
  });
  it('provider tasks allow both VPC Lattice ranges (IPv4 and IPv6)', () => {
    dual.provider.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Provider ECS tasks (netbench)',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: '169.254.171.0/24', FromPort: 8080 }),
        Match.objectLike({ CidrIpv6: 'fd00:ec2:80::/64', FromPort: 8080 }),
      ]),
    });
  });
  it('consumer-side endpoint / association SGs only allow the trusted client SG', () => {
    for (const desc of [
      'PrivateLink interface endpoint - trusted clients only',
      'VPC Lattice service network association - trusted clients only',
      'S3 interface endpoint - trusted clients only',
    ]) {
      const sgs = dual.consumer.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: desc } });
      const [sg] = Object.values(sgs);
      expect(sg).toBeDefined();
      for (const rule of sg.Properties.SecurityGroupIngress) {
        expect(rule.SourceSecurityGroupId).toEqual({ 'Fn::GetAtt': ['TrustedClientSg', 'GroupId'] });
      }
    }
  });
});

describe('PrivateLink', () => {
  it('endpoint service requires acceptance and supports IPv4 + IPv6', () => {
    dual.provider.hasResourceProperties('AWS::EC2::VPCEndpointService', {
      AcceptanceRequired: true,
      SupportedIpAddressTypes: ['ipv4', 'ipv6'],
    });
    dual.provider.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { IpAddressType: 'dualstack' });
  });
  it('only this account may connect', () => {
    dual.provider.hasResourceProperties('AWS::EC2::VPCEndpointServicePermissions', {
      AllowedPrincipals: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::123456789012:root']] }],
    });
  });
  it('consumer endpoint is dual-stack', () => {
    dual.consumer.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      IpAddressType: 'dualstack',
      DnsOptions: { DnsRecordIpType: 'dualstack' },
      PrivateDnsEnabled: false,
    });
  });
});

describe('VPC Lattice', () => {
  it('service network and service use IAM auth', () => {
    dual.provider.hasResourceProperties('AWS::VpcLattice::ServiceNetwork', { AuthType: 'AWS_IAM' });
    dual.provider.hasResourceProperties('AWS::VpcLattice::Service', { AuthType: 'AWS_IAM' });
  });
  it('every auth policy is limited to the consumer VPC', () => {
    const policies = Object.values(dual.provider.findResources('AWS::VpcLattice::AuthPolicy'));
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      for (const st of p.Properties.Policy.Statement) {
        expect(st.Condition.StringEquals['vpc-lattice-svcs:SourceVpc']).toBeDefined();
      }
    }
  });
  it('iam-required rejects anonymous callers', () => {
    const iam = synth({ latticeAuthMode: 'iam-required' });
    iam.provider.hasResourceProperties('AWS::VpcLattice::AuthPolicy', {
      Policy: {
        Statement: [
          Match.objectLike({
            Condition: Match.objectLike({ StringNotEqualsIgnoreCase: { 'aws:PrincipalType': 'anonymous' } }),
          }),
        ],
      },
    });
  });
  it('access logs are enabled and the association has a security group', () => {
    dual.provider.resourceCountIs('AWS::VpcLattice::AccessLogSubscription', 1);
    dual.consumer.hasResourceProperties('AWS::VpcLattice::ServiceNetworkVpcAssociation', {
      SecurityGroupIds: Match.anyValue(),
    });
  });
});

describe('VPC endpoints and S3 data perimeter', () => {
  it('S3 gateway endpoint is dual-stack and its policy lists only the needed buckets, read-only', () => {
    const [ep] = Object.values(dual.consumerVpc.findResources('AWS::EC2::VPCEndpoint', { Properties: { VpcEndpointType: 'Gateway' } }));
    expect(ep.Properties.IpAddressType).toBe('dualstack');
    for (const st of ep.Properties.PolicyDocument.Statement) {
      expect(st.Effect).toBe('Allow');
      expect(st.Action).toBe('s3:GetObject');
    }
    expect(JSON.stringify(ep.Properties.PolicyDocument)).not.toContain('outside');
  });
  it('interface endpoints for AWS services are dual-stack', () => {
    for (const t of [dual.consumerVpc, dual.providerVpc]) {
      t.allResourcesProperties('AWS::EC2::VPCEndpoint', Match.objectLike({}));
      const eps = Object.values(t.findResources('AWS::EC2::VPCEndpoint', { Properties: { VpcEndpointType: 'Interface' } }));
      expect(eps.length).toBeGreaterThanOrEqual(3);
      for (const e of eps) {
        // ec2messages has no dual-stack endpoint; it stays IPv4 (SSM Agent 3.3.40+ does not need it).
        const expected = JSON.stringify(e.Properties.ServiceName).includes('ec2messages') ? 'ipv4' : 'dualstack';
        expect(e.Properties.IpAddressType).toBe(expected);
        expect(e.Properties.DnsOptions.DnsRecordIpType).toBe(expected);
      }
    }
  });
  it('buckets block public access, enforce TLS and allow reads only via the consumer endpoints', () => {
    dual.consumer.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    const policies = Object.values(dual.consumer.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      const [allow, deny] = p.Properties.PolicyDocument.Statement;
      expect(allow.Condition.StringEquals['aws:SourceVpce']).toHaveLength(2);
      expect(deny).toMatchObject({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } });
    }
  });
});

describe('compute hardening', () => {
  it('EC2 requires IMDSv2 with hop limit 1 and encrypted EBS', () => {
    dual.consumer.hasResourceProperties('AWS::EC2::Instance', {
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1 },
      BlockDeviceMappings: [Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true }) })],
    });
  });
  it('containers: read-only root FS, all capabilities dropped, no ECS Exec', () => {
    for (const td of Object.values(dual.provider.findResources('AWS::ECS::TaskDefinition'))) {
      for (const c of td.Properties.ContainerDefinitions) {
        expect(c.ReadonlyRootFilesystem).toBe(true);
        expect(c.LinuxParameters.Capabilities.Drop).toEqual(['ALL']);
      }
    }
    dual.provider.allResourcesProperties('AWS::ECS::Service', { EnableExecuteCommand: false });
  });
  it('the task role has no policies', () => {
    const roles = dual.provider.findResources('AWS::IAM::Role');
    expect(roles.TaskRole.Properties.Policies).toBeUndefined();
    expect(roles.TaskRole.Properties.ManagedPolicyArns).toBeUndefined();
  });
});

describe('IPv6-only mode', () => {
  const v6 = synth({ workloadIpMode: 'ipv6only' });
  it('workload subnets are IPv6-native, edge subnets stay dual-stack', () => {
    const subnets = Object.entries(v6.providerVpc.findResources('AWS::EC2::Subnet'));
    for (const [id, s] of subnets) {
      if (id.startsWith('Workload')) {
        expect(s.Properties.Ipv6Native).toBe(true);
        expect(s.Properties.CidrBlock).toBeUndefined();
      } else {
        expect(s.Properties.Ipv6Native).toBe(false);
        expect(s.Properties.CidrBlock).toBeDefined();
      }
    }
  });
  it('targets are registered by IPv6 end to end', () => {
    v6.provider.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { IpAddressType: 'ipv6' });
    v6.provider.hasResourceProperties('AWS::VpcLattice::TargetGroup', { Config: Match.objectLike({ IpAddressType: 'IPV6' }) });
  });
  it('dual-stack mode registers targets by IPv4', () => {
    dual.provider.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { IpAddressType: 'ipv4' });
    dual.provider.hasResourceProperties('AWS::VpcLattice::TargetGroup', { Config: Match.objectLike({ IpAddressType: 'IPV4' }) });
  });
});

describe('config validation', () => {
  it.each([
    [{ prefix: 'Bad_Prefix' }],
    [{ workloadIpMode: 'ipv4only' }],
    [{ latticeAuthMode: 'none' }],
    [{ desiredCount: 99 }],
    [{ logRetentionDays: 9 }],
  ])('rejects %j', (ctx) => {
    expect(() => synth(ctx)).toThrow();
  });
});

describe('deploy ordering', () => {
  it('every resource that reads Vpc.Ipv6CidrBlocks depends on the IPv6 CIDR association', () => {
    for (const t of [dual.consumerVpc, dual.providerVpc]) {
      const resources = t.toJSON().Resources as Record<string, { DependsOn?: string | string[]; Properties?: unknown }>;
      const assoc = Object.keys(t.findResources('AWS::EC2::VPCCidrBlock'));
      expect(assoc).toHaveLength(1);
      for (const [id, r] of Object.entries(resources)) {
        if (!JSON.stringify(r.Properties ?? {}).includes('Ipv6CidrBlocks')) continue;
        const deps = ([] as string[]).concat(r.DependsOn ?? []);
        expect(deps, `${id} must DependsOn ${assoc[0]}`).toContain(assoc[0]);
      }
    }
  });
});
