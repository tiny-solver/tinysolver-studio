pub mod binary_cache;
pub mod connection;
pub mod error;
pub mod file_system_runtime;
pub mod fork;
pub mod manager;
pub mod opencode_plugins;
pub mod preflight;
pub mod registry;
pub mod session_state;
pub mod terminal_runtime;
pub mod types;

#[allow(unused_imports)] // Re-exports consumed by Phase 1 Task 3 emit_with_state + Phase 2 endpoints
pub use session_state::{
    LiveContentBlock, LiveMessage, LiveSessionSnapshot, PendingPermissionState, SessionState,
    ToolCallOutput, ToolCallState, ToolCallStatus, ToolKind, UsageInfo,
};
pub use types::{AcpEvent, EventEnvelope};
