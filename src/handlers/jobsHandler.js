import {GetCommand, QueryCommand} from "@aws-sdk/lib-dynamodb";

import {dynamo, TABLE_NAME} from "../lib/dynamo.js";
import {forbidden, notFound, ok} from "../lib/response.js";
import {withAuth} from "../middleware/auth.js";

// ─── GET /jobs ───────────────────────────────────────────────────────────────
// Returns all MRF jobs submitted by the authenticated user.
// Queries DynamoDB with PK=userId so only that user's items are returned —
// no risk of leaking another user's jobs.
async function listJobs(event, userId) {
    // 1. Extract query string parameters from the API Gateway event
    const queryParams = event.queryStringParameters || {};

    // Set a default limit, and clamp it to a reasonable max (e.g., max 50)
    const limit = Math.min(parseInt(queryParams.limit) || 20, 50);

    // 2. Decode the nextToken (which is our ExclusiveStartKey)
    let exclusiveStartKey = undefined;
    if (queryParams.nextToken) {
        try {
            // Decode from base64 and parse back to a JSON object
            const decodedToken = Buffer.from(queryParams.nextToken, 'base64').toString('utf-8');
            exclusiveStartKey = JSON.parse(decodedToken);
        } catch (error) {
            // If the token is malformed, return an error (adjust to your error handler)
            return { statusCode: 400, body: JSON.stringify({ message: "Invalid nextToken" }) };
        }
    }

    // 3. Query DynamoDB
    const result = await dynamo.send(
        new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "userId = :uid",
            ExpressionAttributeValues: { ":uid": userId },
            ScanIndexForward: false, // Most recent first
            Limit: limit,            // Limit the number of items fetched
            ExclusiveStartKey: exclusiveStartKey // Start where we left off
        })
    );

    const jobs = (result.Items ?? []).map(sanitizeJob);

    // 4. Generate a new nextToken if there is more data
    let nextToken = null;
    if (result.LastEvaluatedKey) {
        // Encode the LastEvaluatedKey to a base64 string so the frontend can pass it easily
        nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    return ok({
        jobs,
        count: jobs.length,
        nextToken
    });
}

// ─── GET /jobs/:jobId ─────────────────────────────────────────────────────────
// Returns a single job. Verifies the job belongs to the requesting user —
// a user who guesses another user's jobId must not see the record.
async function getJob(event, userId) {
    const jobId = event.pathParameters?.jobId;
    if (!jobId) return notFound("jobId path parameter is required");

    const result = await dynamo.send(
        new GetCommand({
            TableName: TABLE_NAME,
            Key: { userId, jobId },
        })
    );

    if (!result.Item) return notFound("Job not found");
    // Belt-and-suspenders ownership check (GetItem with both PK+SK already scopes
    // to this user, but explicit is better than implicit)
    if (result.Item.userId !== userId) return forbidden();
    return ok(sanitizeJob(result.Item));
}

// Strip internal fields before sending to the client
function sanitizeJob(item) {
    return {
        jobId: item.jobId,
        status: item.status,
        isMrfFileReady: item.isMrfFileReady,
        mrfFileUrl: item.mrfFileUrl ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        // Intentionally omit: presignedUrl, s3Key (internal)
    };
}

// ─── Router ───────────────────────────────────────────────────────────────────
// Both routes share this file — API Gateway routes to the same Lambda,
// we distinguish by whether :jobId is present.
async function handler(event, userId) {
    const jobId = event.pathParameters?.jobId;
    if (jobId) return getJob(event, userId);
    return listJobs(event, userId);
}

export const lambdaHandler = withAuth(handler);