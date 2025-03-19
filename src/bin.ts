import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createSignedFetcher } from "aws-sigv4-fetch";
import { getConfig } from "./config.js";

const config = getConfig();

const runCommand = (command: string, args?: string[]): Promise<void> => {
    const childProcess = spawn(command, args, { env: process.env });

    childProcess.stdout.on("data", (data) => {
        process.stdout.write(data);
    });

    childProcess.stderr.on("data", (data) => {
        process.stderr.write(data);
    });

    return new Promise((resolve, reject) => {
        childProcess.on("close", (code: number) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(`Synth failed with exit code ${code}`);
        });
    });
};

const getTemplateObjectKey = async (): Promise<string> => {
    const json = await readFile("./cdk.out/SidecarStack.assets.json", { encoding: "utf8" });
    const assets = JSON.parse(json) as {
        files: Record<
            string,
            {
                source: {
                    path: string;
                };
                destinations: {
                    "current_account-current_region": {
                        objectKey: string;
                    };
                };
            }
        >;
    };

    for (const asset of Object.values(assets.files)) {
        if (asset.source.path === "SidecarStack.template.json") {
            return asset.destinations["current_account-current_region"].objectKey;
        }
    }

    throw new Error("Failed to locate SidecarStack.template.json");
};

const publishSidecarManifest = async (): Promise<string> => {
    const json = await readFile("./sidecar.manifest.json", { encoding: "utf8" });
    const s3 = new S3Client();
    const objectKey = `${config.sidecarName}/${config.sidecarVersion}/sidecar.manifest.json`;

    await s3.send(
        new PutObjectCommand({
            Bucket: config.assetBucketName,
            Key: objectKey,
            ContentType: "application/json",
            Body: json,
        }),
    );

    return objectKey;
};

const publishVersion = async (
    templateObjectKey: string,
    manifestObjectKey: string,
): Promise<void> => {
    const signedFetch = createSignedFetcher({
        service: "execute-api",
    });

    const response = await signedFetch(`${config.apiEndpoint}/insert-version`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            packageName: config.sidecarName,
            version: config.sidecarVersion,
            templateKey: templateObjectKey,
            manifestKey: manifestObjectKey,
        }),
    });

    if (!response.ok) {
        const result = await response.json();
        console.error(result);

        throw new Error("Failed to insert version");
    }
};

await runCommand("pnpm", ["cdk", "synth"]);
const templateObjectKey = await getTemplateObjectKey();
const manifestObjectKey = await publishSidecarManifest();
await runCommand("pnpm", [
    "dlx",
    "cdk-assets@^2",
    "publish",
    "-p",
    "./cdk.out/SidecarStack.assets.json",
]);
await publishVersion(templateObjectKey, manifestObjectKey);
