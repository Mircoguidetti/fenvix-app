import { DefaultStackSynthesizer } from "aws-cdk-lib";

/**
 * The deploy resources are not made by `cdk bootstrap` (a command run from a laptop) but by the one-click
 * CloudFormation template infra/bootstrap/fenvix-bootstrap.yaml, with its own qualifier, so they never collide with
 * another CDK bootstrap in the account: the assets bucket cdk-fenvix-assets-<account>-<region>, the roles
 * cdk-fenvix-{deploy,file-publishing,cfn-exec}-role-<account>-<region>, and the version parameter
 * /cdk-bootstrap/fenvix/version. No lookup role: the stacks look nothing up.
 */
export const QUALIFIER = "fenvix";

export function synthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({
    qualifier: QUALIFIER,
    useLookupRoleForStackOperations: false,
    // The template's rule would need the toolkit stack's version parameter at deploy time; the CLI checks it anyway.
    generateBootstrapVersionRule: false,
  });
}
