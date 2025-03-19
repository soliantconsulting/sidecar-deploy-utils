export type Config = {
    assetBucketName: string;
    apiEndpoint: string;
    sidecarName: string;
    sidecarVersion: string;
};

type EnvironmentConfig = Omit<Config, "sidecarName" | "sidecarVersion">;

const stagingConfig: EnvironmentConfig = {
    assetBucketName: "sidecar-management-service-sta-assetbucket1d025086-tibvivq50x6e",
    apiEndpoint: "https://4tcg0cqmb5.execute-api.us-east-1.amazonaws.com/prod",
};

const productionConfig: EnvironmentConfig = {
    assetBucketName: "sidecar-management-service-pro-assetbucket1d025086-zogsfd929s3m",
    apiEndpoint: "https://i8nn3a7fdi.execute-api.us-east-1.amazonaws.com/prod",
};

const getEnvVar = (name: string): string => {
    const value = process.env[name];

    if (!value) {
        throw new Error(`${name} environment variable must be specified`);
    }

    return value;
};

export const getConfig = (): Config => {
    const sidecarEnv = process.env.SIDECAR_ENV ?? "production";
    const environmentConfig = sidecarEnv === "production" ? productionConfig : stagingConfig;

    return {
        ...environmentConfig,
        sidecarName: getEnvVar("SIDECAR_NAME"),
        sidecarVersion: getEnvVar("SIDECAR_VERSION"),
    };
};
