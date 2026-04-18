use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub async fn require_token(
    request: Request,
    next: Next,
    token: String,
) -> Response {
    // Allow WebSocket upgrade requests to authenticate via query param.
    // The token value is URL-encoded by the client, so decode before comparing.
    if let Some(query) = request.uri().query() {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            if key != "token" {
                continue;
            }
            if let Ok(decoded) = urlencoding::decode(value) {
                if decoded == token {
                    return next.run(request).await;
                }
            }
        }
    }

    // Check Authorization header
    if let Some(auth_header) = request.headers().get("authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.strip_prefix("Bearer ").is_some_and(|t| t == token) {
                return next.run(request).await;
            }
        }
    }

    (StatusCode::UNAUTHORIZED, "Invalid or missing token").into_response()
}
