import { App, DefaultStackSynthesizer, type Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { getConfig } from "./config.js";

export const createCdkApp = <T extends Stack>(
    StackClass: new (scope: Construct, id: string) => T,
): App => {
    const config = getConfig();

    const app = new App({
        defaultStackSynthesizer: new DefaultStackSynthesizer({
            fileAssetsBucketName: config.assetBucketName,
            generateBootstrapVersionRule: false,
            bucketPrefix: `${config.sidecarName}/${config.sidecarVersion}/`,
            fileAssetPublishingRoleArn: "",
            imageAssetPublishingRoleArn: "",
        }),
        analyticsReporting: false,
    });

    new StackClass(app, "SidecarStack");
    return app;
};
