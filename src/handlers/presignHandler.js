import {PutObjectCommand} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {PutCommand} from "@aws-sdk/lib-dynamodb";
import {randomUUID} from "crypto";
import {BUCKET_NAME, s3, S3_PREFIX} from "../lib/s3.js";
import {dynamo, JOB_STATUS, TABLE_NAME} from "../lib/dynamo.js";
import {badRequest, ok} from "../lib/response.js";
import {withAuth} from "../middleware/auth.js";

const PRESIGNED_URL_EXPIRES_IN = 15 * 60; // 15 minutes

async function handler(event, userId) {
    const body = JSON.parse(event.body ?? "{}");
    const { fileName, contentType = "application/json" } = body;

    if (!fileName) return badRequest("fileName is required");
    if (!contentType.includes("json")) return badRequest("Only JSON uploads are supported");

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const s3Key = `${S3_PREFIX.UPLOADS}${userId}/${jobId}/${fileName}`;

    // Generate the presigned PUT URL — client uploads directly to S3, no server in the middle
    const presignedUrl = await getSignedUrl(
        s3,
        new PutObjectCommand(
            {
            Bucket: BUCKET_NAME,
            Key: s3Key,
            ContentType: contentType,
            // Tag the object so the processor Lambda can read userId without a DynamoDB lookup
            Tagging: `userId=${userId}&jobId=${jobId}`,
        }),
        { expiresIn: PRESIGNED_URL_EXPIRES_IN }
    );

    // Write the PENDING record before returning the URL.
    // If this write fails we return an error and the client never gets the URL,
    // which is safer than the reverse (URL issued but no record exists).
    await dynamo.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                userId,
                jobId,
                s3Key,
                presignedUrl,
                status: JOB_STATUS.PENDING,
                isMrfFileReady: false,
                mrfFileUrl: null,
                createdAt: now,
                updatedAt: now,
            },
            // Prevent accidental overwrite (shouldn't happen with UUIDs but good practice)
            ConditionExpression: "attribute_not_exists(jobId)",
        })
    );

    return ok({
        jobId,
        presignedUrl,
        s3Key,
        expiresIn: PRESIGNED_URL_EXPIRES_IN,
    });
}

export const lambdaHandler = withAuth(handler);