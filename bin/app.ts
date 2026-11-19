#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { ConsumerStack } from '../lib/consumer-stack';
import { ProviderStack } from '../lib/provider-stack';
import { VpcStack } from '../lib/vpc-stack';

const app = new App();
const config = loadConfig(app);
const p = config.prefix;
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1' };

// Both VPCs use 10.0.0.0/16 on purpose (overlapping IPv4, security scenario X-6).
const consumerVpc = new VpcStack(app, `${p}-consumer-vpc`, { env, config, role: 'consumer', ipv4Cidr: '10.0.0.0/16' });
const providerVpc = new VpcStack(app, `${p}-provider-vpc`, { env, config, role: 'provider', ipv4Cidr: '10.0.0.0/16' });
const provider = new ProviderStack(app, `${p}-provider`, { env, config, providerVpc, consumerVpcId: consumerVpc.vpcId });
new ConsumerStack(app, `${p}-consumer`, { env, config, consumerVpc, provider });

Tags.of(app).add('Project', p);
