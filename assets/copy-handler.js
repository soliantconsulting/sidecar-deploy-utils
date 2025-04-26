const response = require("cfn-response");
const {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const s3Source = new S3Client({region: "us-east-1"});
const s3Target = new S3Client({});

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
            await response.send(event, context, response.SUCCESS);
    }
};

const handleCreateOrUpdate = async (event, context) => {
    try {
        const sourceBucket = event.ResourceProperties.SourceBucketName;
        const targetBucket = event.ResourceProperties.TargetBucketName;
        const bucketPrefix = event.ResourceProperties.BucketPrefix;

        let continuationToken = undefined;

        do {
            const listResponse = await s3Source.send(new ListObjectsV2Command({
                Bucket: sourceBucket,
                Prefix: bucketPrefix,
                ContinuationToken: continuationToken,
            }));

            const objects = listResponse.Contents ?? [];

            await Promise.all(objects.map(async (obj) => {
                const sourceKey = obj.Key;

                if (!sourceKey) {
                    return;
                }

                const targetKey = sourceKey;

                const getObjectResponse = await s3Source.send(new GetObjectCommand({
                    Bucket: sourceBucket,
                    Key: sourceKey,
                }));

                await s3Target.send(new PutObjectCommand({
                    Bucket: targetBucket,
                    Key: targetKey,
                    Body: getObjectResponse.Body,
                }));

                console.info(`Copied: ${sourceKey} to ${targetKey}`);
            }));

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        await response.send(event, context, response.SUCCESS);
    } catch (error) {
        console.error(error);
        await response.send(event, context, response.FAILED);
    }
};

const handleDelete = async (event, context) => {
    try {
        const targetBucket = event.ResourceProperties.TargetBucketName;

        let continuationToken = undefined;

        do {
            const listResponse = await s3Target.send(new ListObjectsV2Command({
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

                await s3Target.send(new DeleteObjectsCommand(deleteParams));

                console.info(`Deleted ${objects.length} objects from ${targetBucket}`);
            }

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        await response.send(event, context, response.SUCCESS);
    } catch (error) {
        console.error(error);
        await response.send(event, context, response.FAILED);
    }
};
