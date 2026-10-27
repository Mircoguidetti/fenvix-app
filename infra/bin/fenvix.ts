#!/usr/bin/env node
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { envVarName, loadConfig } from '../lib/config';
import { FenvixStack } from '../lib/fenvix-stack';

const app = new App();
const ctx = (key: string): string | undefined => {
  const v = app.node.tryGetContext(key) ?? process.env[envVarName(key)];
  return v === undefined || v === null ? undefined : String(v);
};

const config = loadConfig(ctx);

// Guard against deploying to the wrong account: if the CLI knows the account, it must match.
const cliAccount = process.env.CDK_DEFAULT_ACCOUNT;
if (config.account && cliAccount && cliAccount !== config.account) {
  throw new Error(`Credentials are for account ${cliAccount} but the configured account is ${config.account}. Refusing to continue.`);
}
const account = config.account ?? cliAccount;
if (!account) throw new Error('No AWS account: set "account" in cdk.json or use credentials (CDK_DEFAULT_ACCOUNT).');

config.regions.forEach((region, index) => {
  new FenvixStack(app, `fenvix-${config.envName}-${region}`, {
    env: { account, region },
    config,
    region,
    createDns: index === 0,
    // No assets in this stack, so no bootstrap stack is needed (see README).
    synthesizer: new BootstraplessSynthesizer(),
    description: `FENVIX engine node (${config.envName}, ${region})`,
  });
});
