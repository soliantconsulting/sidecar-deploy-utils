import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    App,
    CfnResource,
    DefaultStackSynthesizer,
    type DockerImageAssetLocation,
    Duration,
    type FileAssetLocation,
    type FileAssetSource,
    Fn,
    RemovalPolicy,
    Stack,
} from "aws-cdk-lib";
import { CfnFunction, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { getConfig } from "./config.js";

export const createCdkApp = <T extends Stack>(
    StackClass: new (scope: Construct, id: string) => T,
): App => {
    const config = getConfig();

    const app = new App({
        defaultStackSynthesizer: new SidecarSynthesizer({
            bucketName: config.assetBucketName,
            bucketPrefix: `${config.sidecarName}/${config.sidecarVersion}/`,
            version: config.sidecarVersion,
        }),
        analyticsReporting: false,
    });

    const stack = new StackClass(app, "SidecarStack");
    const sidecarAssetTransfer = new SidecarAssetTransfer(stack, "SidecarAssetTransfer");

    for (const node of stack.node.findAll()) {
        if (node instanceof CfnFunction) {
            if ("s3Bucket" in node.code && node.code.s3Bucket === localAssetBucketName) {
                node.addDependency(sidecarAssetTransfer.resource);
            }

            continue;
        }

        if (node instanceof CfnResource && node.cfnResourceType === "AWS::Lambda::Function") {
            // biome-ignore lint/complexity/useLiteralKeys: Access to protected properties
            const properties = node["cfnProperties"] as {
                Code: {
                    S3Bucket?: string;
                };
            };

            if (properties.Code.S3Bucket === localAssetBucketName) {
                node.addDependency(sidecarAssetTransfer.resource);
            }
        }
    }

    return app;
};

const localAssetBucketName = Fn.sub("${AWS::StackName}-assets-${AWS::AccountId}-${AWS::Region}");

type SidecarSynthesizerProps = {
    bucketName: string;
    bucketPrefix: string;
    version: string;
};

class SidecarSynthesizer extends DefaultStackSynthesizer {
    public readonly sidecarBucketName: string;
    public readonly sidecarBucketPrefix: string;
    public readonly sidecarVersion: string;

    public constructor(props: SidecarSynthesizerProps) {
        super({
            fileAssetsBucketName: props.bucketName,
            generateBootstrapVersionRule: false,
            bucketPrefix: props.bucketPrefix,
            fileAssetPublishingRoleArn: "",
            imageAssetPublishingRoleArn: "",
        });

        this.sidecarBucketName = props.bucketName;
        this.sidecarBucketPrefix = props.bucketPrefix;
        this.sidecarVersion = props.version;
    }

    public override addFileAsset(asset: FileAssetSource): FileAssetLocation {
        return {
            ...super.addFileAsset(asset),
            bucketName: localAssetBucketName,
        };
    }

    public override addDockerImageAsset(): DockerImageAssetLocation {
        throw new Error("Docker image assets are not supported");
    }
}

class SidecarAssetTransfer extends Construct {
    public readonly resource: CfnResource;

    public constructor(scope: Construct, id: string) {
        super(scope, id);
        const { synthesizer } = Stack.of(this);

        if (!(synthesizer instanceof SidecarSynthesizer)) {
            throw new Error("S3AssetTransfer requires SidecarSynthesizer");
        }

        const bucket = new Bucket(this, "AssetBucket", {
            bucketName: localAssetBucketName,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const copyCode = readFileSync(
            fileURLToPath(new URL("../assets/copy-handler.min.js", import.meta.url)),
            { encoding: "utf8" },
        );

        const copyFunction = new LambdaFunction(this, "CopyFunction", {
            runtime: Runtime.NODEJS_LATEST,
            handler: "index.handler",
            memorySize: 1024,
            timeout: Duration.minutes(5),
            allowPublicSubnet: true,
            code: Code.fromInline(copyCode),
        });
        bucket.grantReadWrite(copyFunction);

        this.resource = new CfnResource(this, "CopyResource", {
            type: "Custom::SidecarAssetTransfer",
            properties: {
                // This property ensures that the resource only runs on version change, or if "main", whenever a new
                // main version was pushed.
                Version:
                    synthesizer.sidecarVersion === "main"
                        ? `main-${new Date().toISOString()}`
                        : synthesizer.sidecarVersion,
                SourceBucketName: synthesizer.sidecarBucketName,
                TargetBucketName: bucket.bucketName,
                BucketPrefix: synthesizer.sidecarBucketPrefix,
                ServiceToken: copyFunction.functionArn,
                ServiceTimeout: copyFunction.timeout?.toSeconds(),
            },
        });

        if (bucket.policy) {
            this.resource.node.addDependency(bucket.policy);
        }

        this.resource.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }
}
