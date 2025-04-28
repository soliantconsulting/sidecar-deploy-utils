import { readFile } from "node:fs/promises";
import {
    CloudFormationClient,
    CreateStackCommand,
    DeleteStackCommand,
    DescribeStacksCommand,
    type Parameter,
    waitUntilStackCreateComplete,
    waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";
import { DeleteParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { type Config, getConfig } from "./config.js";

type TemplateLocation = {
    bucketName: string;
    region: string;
    objectKey: string;
};

const mapParameters = (params?: Record<string, string>): Parameter[] | undefined => {
    if (!params) {
        return undefined;
    }

    return Object.entries(params).map(([ParameterKey, ParameterValue]) => ({
        ParameterKey,
        ParameterValue,
    }));
};

const createStack = async (
    cf: CloudFormationClient,
    stackName: string,
    templateLocation: TemplateLocation,
    parameters?: Record<string, string>,
) => {
    const { bucketName, region, objectKey } = templateLocation;
    const templateUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${objectKey}`;

    console.info(`Creating stack: ${stackName} with template from ${templateUrl}`);
    await cf.send(
        new CreateStackCommand({
            StackName: stackName,
            TemplateURL: templateUrl,
            Parameters: mapParameters(parameters),
            Capabilities: ["CAPABILITY_NAMED_IAM"],
        }),
    );

    console.info("Waiting for stack creation to complete...");
    await waitUntilStackCreateComplete({ client: cf, maxWaitTime: 600 }, { StackName: stackName });
    console.info(`Stack ${stackName} created successfully.`);
};

const deleteStack = async (cf: CloudFormationClient, stackName: string) => {
    console.info(`Deleting stack: ${stackName}`);

    await cf.send(new DeleteStackCommand({ StackName: stackName }));
    console.info("Waiting for stack deletion to complete...");

    await waitUntilStackDeleteComplete({ client: cf, maxWaitTime: 600 }, { StackName: stackName });
    console.info(`Stack ${stackName} deleted successfully.`);
};

const getStackOutputs = async (
    cf: CloudFormationClient,
    stackName: string,
): Promise<Record<string, string>> => {
    const result = await cf.send(new DescribeStacksCommand({ StackName: stackName }));

    return (result.Stacks?.[0]?.Outputs || []).reduce(
        (outputs, output) => {
            if (output.OutputKey && output.OutputValue) {
                outputs[output.OutputKey] = output.OutputValue;
            }

            return outputs;
        },
        {} as Record<string, string>,
    );
};

type Credentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
};

const assumeRole = async (sts: STSClient, config: Config): Promise<Credentials> => {
    const { Credentials } = await sts.send(
        new AssumeRoleCommand({
            RoleArn: `arn:aws:iam::${config.testAccountId}:role/AutomationAccountAccessRole`,
            RoleSessionName: `sidecar-verification-${config.sidecarName}`,
        }),
    );

    if (!(Credentials?.AccessKeyId && Credentials?.SecretAccessKey && Credentials?.SessionToken)) {
        throw new Error("STS result does not contain credentials");
    }

    return {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
    };
};

type AwsClients = {
    cf: CloudFormationClient;
    ssm: SSMClient;
};

const createRemoteAwsClients = async (config: Config): Promise<AwsClients> => {
    const sts = new STSClient({});
    const credentials = await assumeRole(sts, config);

    return {
        cf: new CloudFormationClient({
            region: "us-east-2",
            credentials: credentials,
        }),
        ssm: new SSMClient({
            region: "us-east-2",
            credentials,
        }),
    };
};

export type TestMainStackOptions = {
    config: Record<string, unknown>;
    parameters?: Record<string, string>;
    stackTest?: (stackName: string, outputs: Record<string, string>) => Promise<void>;
};

export const testMainStack = async (options: TestMainStackOptions): Promise<void> => {
    const config = getConfig();
    const stackName = `sidecar-verification-${config.sidecarName}`;
    const configParameterName = `/${stackName}`;
    const parameters = {
        ...options.parameters,
        ConfigParameterName: configParameterName,
        ConfigParameterVersion: new Date().toISOString(),
    };

    let mainTemplateObjectKey: string;

    try {
        mainTemplateObjectKey = (
            await readFile("main-template-object-key", { encoding: "utf-8" })
        ).trim();
    } catch (error) {
        console.error("Failed to read template object key:", error);
        process.exit(1);
    }

    console.info(`Deploying to account ${config.testAccountId} in ${config.testRegion} region`);

    let cf: CloudFormationClient;
    let ssm: SSMClient;

    try {
        const clients = await createRemoteAwsClients(config);
        cf = clients.cf;
        ssm = clients.ssm;
    } catch (error) {
        console.error("Failed to get remote clients:", error);
        process.exit(1);
    }

    let stackCreated = false;
    let callbackError: unknown = undefined;

    try {
        await ssm.send(
            new PutParameterCommand({
                Name: configParameterName,
                Type: "SecureString",
                Value: JSON.stringify(options.config),
            }),
        );

        await createStack(
            cf,
            stackName,
            {
                bucketName: config.assetBucketName,
                region: "us-east-1",
                objectKey: mainTemplateObjectKey,
            },
            parameters,
        );

        stackCreated = true;

        if (options.stackTest) {
            try {
                const outputs = await getStackOutputs(cf, stackName);
                await options.stackTest(stackName, outputs);
            } catch (error) {
                console.error("Error during stack test:", error);
                callbackError = error;
            }
        }
    } catch (error) {
        console.error("Error during stack deployment:", error);
        process.exitCode = 1;
    } finally {
        try {
            if (stackCreated) {
                await deleteStack(cf, stackName);
            } else {
                console.info("Stack creation failed; skipping delete for introspection.");
            }

            await ssm.send(
                new DeleteParameterCommand({
                    Name: configParameterName,
                }),
            );
        } catch (error) {
            console.error("Error during stack cleanup:", error);
            process.exit(1);
        }

        if (callbackError) {
            process.exit(1);
        }

        process.exit(process.exitCode);
    }
};
