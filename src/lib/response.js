const CORS_HEADERS = {
    "Access-Control-Allow-Origin": process.env.FRONTEND_ORIGIN ?? "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export function ok(body, statusCode = 200) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify(body),
    };
}

export function created(body) {
    return ok(body, 201);
}

export function badRequest(message) {
    return error(400, message);
}

export function unauthorized(message = "Unauthorized") {
    return error(401, message);
}

export function forbidden(message = "Forbidden") {
    return error(403, message);
}

export function notFound(message = "Not found") {
    return error(404, message);
}

export function serverError(message = "Internal server error") {
    return error(500, message);
}

function error(statusCode, message) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({ error: message }),
    };
}