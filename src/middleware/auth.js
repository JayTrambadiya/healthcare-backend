import { unauthorized } from "../lib/response.js";

/**
 * API Gateway HTTP API with a Cognito JWT authorizer automatically validates
 * the token and injects the claims into event.requestContext.authorizer.jwt.claims.
 * We never need to verify the JWT ourselves — Gateway rejects invalid tokens
 * before Lambda is even invoked.
 *
 * The `sub` claim is the stable Cognito user ID (works for both email/password
 * and Google federated logins).
 */
export function getUserId(event) {
    const claims = event?.requestContext?.authorizer?.jwt?.claims;
    if (!claims?.sub) return null;
    return claims.sub;
}

export function requireAuth(event) {
    const userId = getUserId(event);
    if (!userId) throw new AuthError();
    return userId;
}

export class AuthError extends Error {
    constructor() {
        super("Unauthorized");
        this.name = "AuthError";
    }
}

/**
 * Wraps a handler function to automatically:
 *  - Extract userId from JWT claims
 *  - Return 401 if missing
 *  - Catch unexpected errors and return 500
 */
export function withAuth(handler) {
    return async (event) => {
        try {
            const userId = requireAuth(event);
            return await handler(event, userId);
        } catch (err) {
            if (err instanceof AuthError) return unauthorized();
            console.error("[handler error]", err);
            return {
                statusCode: 500,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Internal server error" }),
            };
        }
    };
}