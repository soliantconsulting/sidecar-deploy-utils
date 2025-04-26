const response = require("cfn-response");
const { S3Client, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});

exports.handler = async (event, context) => {
    if (event.RequestType === "Delete") {
        await response.send(response, context, response.SUCCESS);
        return;
    }

    try {
        const sourceBucket = event.ResourceProperties.SourceBucketName;
        const targetBucket = event.ResourceProperties.TargetBucketName;
        const bucketPrefix = event.ResourceProperties.BucketPrefix;

        let continuationToken = undefined;

        do {
            const listResponse = await s3.send(new ListObjectsV2Command({
                Bucket: sourceBucket,
                Prefix: bucketPrefix,
                ContinuationToken: continuationToken,
            }));

            const objects = listResponse.Contents ?? [];

            for (const obj of objects) {
                const sourceKey = obj.Key;

                if (!sourceKey) {
                    continue;
                }

                const targetKey = sourceKey;

                await s3.send(new CopyObjectCommand({
                    Bucket: targetBucket,
                    Key: targetKey,
                    CopySource: `${sourceBucket}/${sourceKey}`,
                }));

                console.info(`Copied: ${sourceKey} to ${targetKey}`);
            }

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        await response.send(response, context, response.SUCCESS);
    } catch (error) {
        console.error(error);
        await response.send(response, context, response.FAILED);
    }
};
