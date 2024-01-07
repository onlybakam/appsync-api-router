// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface AppsyncApiRouterProps {
  // Define construct properties here
}

export class AppsyncApiRouter extends Construct {

  constructor(scope: Construct, id: string, props: AppsyncApiRouterProps = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'AppsyncApiRouterQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
