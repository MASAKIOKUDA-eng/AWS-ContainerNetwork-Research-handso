import type { App } from 'aws-cdk-lib';

/** Lab settings. Override with `-c key=value` (cdkd and cdk both accept it) or in cdk.json. */
export interface LabConfig {
  /** Name prefix for stacks and resources (3-16 chars: a-z, 0-9, -). */
  readonly prefix: string;
  /** dualstack = workload subnets IPv4 + IPv6, ipv6only = IPv6-only workload subnets. */
  readonly workloadIpMode: 'dualstack' | 'ipv6only';
  /** IP address type of the interface endpoints for AWS services. ipv4 is a fallback only. */
  readonly endpointIpAddressType: 'dualstack' | 'ipv4';
  /** S3 gateway endpoint IP address type (IPv6 support: Nov 2025). */
  readonly s3GatewayIpAddressType: 'dualstack' | 'ipv4';
  /** vpc-only = anonymous callers from the consumer VPC; iam-required = SigV4 callers of this account only. */
  readonly latticeAuthMode: 'vpc-only' | 'iam-required';
  /** Evaluate the NLB security group for PrivateLink traffic. */
  readonly nlbEnforceSgOnPrivateLink: 'on' | 'off';
  readonly desiredCount: number;
  readonly taskCpu: '256' | '512' | '1024';
  readonly taskMemory: '512' | '1024' | '2048';
  /** Must match the platform the images are built for. */
  readonly cpuArchitecture: 'X86_64' | 'ARM64';
  /** Nitro instance type (required in IPv6-only subnets). */
  readonly loadgenInstanceType: string;
  readonly logRetentionDays: 1 | 3 | 5 | 7 | 14 | 30;
}

function oneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): T {
  const v = String(value);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`context "${key}" must be one of ${allowed.join(' | ')} (got "${v}")`);
  }
  return v as T;
}

function intInRange(key: string, value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`context "${key}" must be an integer between ${min} and ${max} (got "${String(value)}")`);
  }
  return n;
}

/** Reads and validates the context. Invalid values fail the synth instead of reaching AWS. */
export function loadConfig(app: App): LabConfig {
  const ctx = (key: string, fallback: unknown) => app.node.tryGetContext(key) ?? fallback;

  const prefix = String(ctx('prefix', 'v6lab'));
  if (!/^[a-z0-9-]{3,16}$/.test(prefix)) {
    throw new Error(`context "prefix" must match ^[a-z0-9-]{3,16}$ (got "${prefix}")`);
  }
  const loadgenInstanceType = String(ctx('loadgenInstanceType', 'c7i.xlarge'));
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(loadgenInstanceType)) {
    throw new Error(`context "loadgenInstanceType" is not an instance type (got "${loadgenInstanceType}")`);
  }

  return {
    prefix,
    workloadIpMode: oneOf('workloadIpMode', ctx('workloadIpMode', 'dualstack'), ['dualstack', 'ipv6only'] as const),
    endpointIpAddressType: oneOf('endpointIpAddressType', ctx('endpointIpAddressType', 'dualstack'), ['dualstack', 'ipv4'] as const),
    s3GatewayIpAddressType: oneOf('s3GatewayIpAddressType', ctx('s3GatewayIpAddressType', 'dualstack'), ['dualstack', 'ipv4'] as const),
    latticeAuthMode: oneOf('latticeAuthMode', ctx('latticeAuthMode', 'vpc-only'), ['vpc-only', 'iam-required'] as const),
    nlbEnforceSgOnPrivateLink: oneOf('nlbEnforceSgOnPrivateLink', ctx('nlbEnforceSgOnPrivateLink', 'off'), ['on', 'off'] as const),
    desiredCount: intInRange('desiredCount', ctx('desiredCount', 2), 0, 10),
    taskCpu: oneOf('taskCpu', ctx('taskCpu', '512'), ['256', '512', '1024'] as const),
    taskMemory: oneOf('taskMemory', ctx('taskMemory', '1024'), ['512', '1024', '2048'] as const),
    cpuArchitecture: oneOf('cpuArchitecture', ctx('cpuArchitecture', 'X86_64'), ['X86_64', 'ARM64'] as const),
    loadgenInstanceType,
    logRetentionDays: Number(
      oneOf('logRetentionDays', ctx('logRetentionDays', 7), ['1', '3', '5', '7', '14', '30'] as const),
    ) as LabConfig['logRetentionDays'],
  };
}
