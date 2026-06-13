//! The custom `tracing` layer that feeds the in-memory ring buffer and the
//! live-tail event stream. Runs alongside the stderr fmt layer and the JSON
//! file layer in the subscriber stack ([`crate::logging::init`]).

use std::cell::Cell;
use std::fmt::Write as _;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use crate::logging::hub::{log_hub, LogRecord};

thread_local! {
    /// Reentrancy guard. The emit path in `LogHub::record` (broadcast + serde)
    /// can transitively call `tracing::*`; without this, that event would
    /// re-enter `on_event` → `record` → emit → … unbounded on the same thread.
    static IN_LAYER: Cell<bool> = const { Cell::new(false) };
}

/// Extracts the `message` field (the format string / literal) from an event,
/// ignoring structured key-value fields — the viewer renders a single human
/// line, matching the migrated `eprintln!` text.
#[derive(Default)]
struct MessageVisitor {
    message: String,
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        }
    }
}

/// Layer that converts each event into a [`LogRecord`] and hands it to the
/// global [`LogHub`]. A no-op until the hub is installed (so `codeg-mcp`, which
/// installs no hub, pays nothing).
pub struct BufferEmitLayer;

impl<S: Subscriber> Layer<S> for BufferEmitLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        // Same-thread reentry from the emit path → no-op.
        if IN_LAYER.with(|f| f.replace(true)) {
            return;
        }
        // Clear the guard even if anything below panics.
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                IN_LAYER.with(|f| f.set(false));
            }
        }
        let _reset = Reset;

        let Some(hub) = log_hub() else {
            return;
        };

        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);

        let meta = event.metadata();
        hub.record(LogRecord {
            seq: hub.next_seq(),
            timestamp_ms: now_ms(),
            level: meta.level().as_str(),
            target: meta.target().to_string(),
            message: visitor.message,
        });
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
