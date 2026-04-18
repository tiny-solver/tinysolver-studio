use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::app_error::{AppCommandError, AppErrorCode};

impl IntoResponse for AppCommandError {
    fn into_response(self) -> Response {
        let status = match self.code {
            AppErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
            AppErrorCode::NotFound => StatusCode::NOT_FOUND,
            AppErrorCode::AlreadyExists => StatusCode::CONFLICT,
            AppErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
            AppErrorCode::AuthenticationFailed => StatusCode::UNAUTHORIZED,
            AppErrorCode::ConfigurationMissing
            | AppErrorCode::ConfigurationInvalid
            | AppErrorCode::DependencyMissing
            | AppErrorCode::NotAGitRepository => StatusCode::UNPROCESSABLE_ENTITY,
            AppErrorCode::NetworkError
            | AppErrorCode::DatabaseError
            | AppErrorCode::IoError
            | AppErrorCode::ExternalCommandFailed
            | AppErrorCode::WindowOperationFailed
            | AppErrorCode::TaskExecutionFailed => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self)).into_response()
    }
}
