const response = require("cfn-response");
const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});

exports.handler = async (event, context) => {
    switch (event.RequestType) {
        case "Create":
        case "Update": {
            await handleCreateOrUpdate(event, context);
            break;
        }

        case "Delete": {
            await handleDelete(event, context);
            break;
        }

        default:
            await response.send(response, context, response.SUCCESS);
    }
};

const handleCreateOrUpdate = async (event, context) => {
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

const handleDelete = async (event, context) => {
    try {
        const targetBucket = event.ResourceProperties.TargetBucketName;

        let continuationToken = undefined;

        do {
            const listResponse = await s3.send(new ListObjectsV2Command({
                Bucket: targetBucket,
                ContinuationToken: continuationToken,
            }));

            const objects = listResponse.Contents ?? [];

            if (objects.length > 0) {
                const deleteParams = {
                    Bucket: targetBucket,
                    Delete: {
                        Objects: objects.map(obj => ({Key: obj.Key})),
                        Quiet: true,
                    },
                };

                await s3.send(new DeleteObjectsCommand(deleteParams));

                console.info(`Deleted ${objects.length} objects from ${targetBucket}`);
            }

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        await response.send(response, context, response.SUCCESS);
    } catch (error) {
        console.error(error);
        await response.send(response, context, response.FAILED);
    }
};
