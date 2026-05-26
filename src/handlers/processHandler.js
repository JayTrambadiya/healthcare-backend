import {GetObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import {UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {ConditionalCheckFailedException} from "@aws-sdk/client-dynamodb";
import {BUCKET_NAME, s3, S3_PREFIX} from "../lib/s3.js";
import {dynamo, JOB_STATUS, TABLE_NAME} from "../lib/dynamo.js";

export async function lambdaHandler(event) {
    const results = await Promise.allSettled(
        event.Records.map((record) => processRecord(record))
    );

    const batchItemFailures = results
        .map((result, index) => {
            if (result.status === "rejected") {
                console.error("[processHandler] record failed:", result.reason);
                return { itemIdentifier: event.Records[index].messageId };
            }
            return null;
        })
        .filter(Boolean);

    return { batchItemFailures };
}

// ─── Single record ─────────────────────────────────────────────────────────
async function processRecord(sqsRecord) {
    const s3Event = JSON.parse(sqsRecord.body);
    const s3Record = s3Event.Records?.[0];
    if (!s3Record) throw new Error("No S3 record in SQS message");

    const s3Key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, " "));

    // uploads/{userId}/{jobId}/{fileName}
    const [, userId, jobId] = s3Key.split("/");
    if (!userId || !jobId) throw new Error(`Cannot parse userId/jobId from key: ${s3Key}`);

    const claimed = await claimJob(userId, jobId);
    if (!claimed) {
        // Job is already PROCESSING, DONE, or FAILED — safe to skip.
        // Return normally so SQS deletes this message (no retry needed).
        console.log(`[processHandler] job ${jobId} already claimed, skipping duplicate event`);
        return;
    }

    // ── Process ──────────────────────────────────────────────────────────────
    try {
        const rawJson = await readJsonFromS3(s3Key);
        const mrfData = convertToMrf(rawJson, { userId, jobId });

        const mrfKey = `${S3_PREFIX.MRF_FILES}${userId}/${jobId}/output.json`;
        await writeMrfToS3(mrfKey, mrfData);

        const mrfFileUrl = buildPublicUrl(mrfKey);
        await updateJobDone(userId, jobId, mrfFileUrl);

        console.log(`[processHandler] job ${jobId} completed`);
    } catch (err) {
        console.error(`[processHandler] job ${jobId} failed:`, err);
        // Reset to FAILED — also resets the lock so a manual retry is possible
        await updateJobStatus(userId, jobId, JOB_STATUS.FAILED).catch(() => {});
        throw err;
    }
}

// ─── Idempotency: atomic claim ────────────────────────────────────────────────
// Returns true  → this invocation owns the job, proceed
// Returns false → another invocation already claimed it, skip
async function claimJob(userId, jobId) {
    try {
        await dynamo.send(
            new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { userId, jobId },
                UpdateExpression: "SET #status = :processing, updatedAt = :now",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                    ":processing": JOB_STATUS.PROCESSING,
                    ":pending": JOB_STATUS.PENDING,
                    ":now": new Date().toISOString(),
                },
            })
        );
        return true; // We won the race
    } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
            return false; // Someone else already claimed it
        }
        throw err; // Unexpected error — let SQS retry
    }
}

// ─── S3 helpers ──────────────────────────────────────────────────────────────
async function readJsonFromS3(key) {
    const response = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
    );
    const bodyStr = await streamToString(response.Body);
    return JSON.parse(bodyStr);
}

async function writeMrfToS3(key, data) {
    await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: JSON.stringify(data, null, 2),
            ContentType: "application/json",
        })
    );
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
    });
}

// ─── MRF conversion ──────────────────────────────────────────────────────────
function convertToMrf(rawData, { userId, jobId }) {
    const records = Array.isArray(rawData) ? rawData : [rawData];
    return {
        mrfVersion: "1.0.0",
        jobId,
        userId,
        generatedAt: new Date().toISOString(),
        recordCount: records.length,
        data: records,// can use map to mutate
    };
}

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────
async function updateJobStatus(userId, jobId, status) {
    await dynamo.send(
        new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { userId, jobId },
            UpdateExpression: "SET #status = :status, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":status": status,
                ":now": new Date().toISOString(),
            },
        })
    );
}

async function updateJobDone(userId, jobId, mrfFileUrl) {
    await dynamo.send(
        new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { userId, jobId },
            UpdateExpression:
                "SET #status = :status, isMrfFileReady = :ready, mrfFileUrl = :url, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":status": JOB_STATUS.DONE,
                ":ready": true,
                ":url": mrfFileUrl,
                ":now": new Date().toISOString(),
            },
        })
    );
}

function buildPublicUrl(s3Key) {
    const region = process.env.AWS_DEFAULT_REGION ?? "ap-south-1";
    return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${s3Key}`;
}