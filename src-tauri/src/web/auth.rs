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
    // Allow WebSocket upgrade requests to authenticate via query param
    if let Some(query) = request.uri().query() {
        if query.contains(&format!("token={}", token)) {
            return next.run(request).await;
        }
    }

    // Check Authorization header
    if let Some(auth_header) = request.headers().get("authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.strip_prefix("Bearer ").map_or(false, |t| t == token) {
                return next.run(request).await;
            }
        }
    }

    (StatusCode::UNAUTHORIZED, "Invalid or missing token").into_response()
}
