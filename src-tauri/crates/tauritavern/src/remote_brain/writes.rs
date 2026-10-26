//! Keeps the PC and the phone from overwriting each other's newer data.
//!
//! Each page holds chats and settings in memory from when it loaded. If the
//! other device saved since then, a save from this page would put old data
//! back. So every data write is checked against what the page has seen:
//! - the phone sends the PC write count it loaded with; a newer PC write
//!   refuses the phone's save and the phone reloads;
//! - the PC page records the phone write count when it loads; a newer phone
//!   write refuses the PC's save and the PC page reloads.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::Emitter;

/// Header the PC Brain server adds to every command it runs for the phone.
pub const FROM_PHONE_HEADER: &str = "x-tt-remote-brain";
/// PC write count the phone page loaded with.
pub const SEEN_PC_WRITES_HEADER: &str = "x-tt-remote-brain-seen";

pub const STALE_PHONE: &str = "PC Brain: your PC changed things since this page loaded. Reloading to the latest so nothing is overwritten.";
pub const STALE_PC: &str = "PC Brain: your phone changed things since this window loaded. Reloading to the latest so nothing is overwritten.";
pub const STALE_EVENT: &str = "remote-brain:stale";

static PC_WRITES: AtomicU64 = AtomicU64::new(0);
static PHONE_WRITES: AtomicU64 = AtomicU64::new(0);
static PC_PAGE_SEEN_PHONE_WRITES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCounters {
    pub pc_writes: u64,
    pub phone_writes: u64,
}

pub fn counters() -> WriteCounters {
    WriteCounters {
        pc_writes: PC_WRITES.load(Ordering::SeqCst),
        phone_writes: PHONE_WRITES.load(Ordering::SeqCst),
    }
}

/// The PC's main page started loading: it now holds everything written so far.
pub fn pc_page_loaded() {
    PC_PAGE_SEEN_PHONE_WRITES.store(PHONE_WRITES.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// Runs before every app command. `Err` refuses a save from a stale page.
pub fn check_invoke(invoke: &tauri::ipc::Invoke<tauri::Wry>) -> Result<(), &'static str> {
    if !is_data_write(invoke.message.command()) {
        return Ok(());
    }
    let headers = invoke.message.headers();
    if headers.contains_key(FROM_PHONE_HEADER) {
        let seen = headers
            .get(SEEN_PC_WRITES_HEADER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        if let Some(seen) = seen
            && PC_WRITES.load(Ordering::SeqCst) > seen
        {
            return Err(STALE_PHONE);
        }
        PHONE_WRITES.fetch_add(1, Ordering::SeqCst);
        return Ok(());
    }

    if PHONE_WRITES.load(Ordering::SeqCst) > PC_PAGE_SEEN_PHONE_WRITES.load(Ordering::SeqCst) {
        let _ = invoke.message.webview_ref().emit_to(
            tauri::EventTarget::webview_window("main"),
            STALE_EVENT,
            STALE_PC,
        );
        return Err(STALE_PC);
    }
    PC_WRITES.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

const WRITE_PREFIXES: &[&str] = &[
    "add_", "adopt_", "assign_", "backup_", "bulk_", "create_", "delete_", "duplicate_",
    "finish_", "import_", "merge_", "move_", "rename_", "replace_", "resolve_character_lorebook",
    "restore_", "rotate_", "save_", "set_", "unassign_", "update_", "upload_", "write_",
];

const NOT_DATA: &[&str] = &[
    "set_window_backdrop",
    "set_data_root",
    "set_agent_extension_tool_enabled",
    "save_export_data_archive",
    "update_tauritavern_settings",
];

fn is_data_write(command: &str) -> bool {
    !command.starts_with("plugin:")
        && !command.starts_with("remote_brain_")
        && !command.starts_with("lan_sync_")
        && !command.starts_with("devlog_")
        && !NOT_DATA.contains(&command)
        && WRITE_PREFIXES.iter().any(|prefix| command.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::is_data_write;

    #[test]
    fn classifies_commands() {
        assert!(is_data_write("finish_chat_commit"));
        assert!(is_data_write("update_character_card_data"));
        assert!(is_data_write("delete_chat"));
        assert!(!is_data_write("get_bootstrap_metadata"));
        assert!(!is_data_write("append_chat_commit_chunk"));
        assert!(!is_data_write("begin_chat_commit"));
        assert!(!is_data_write("read_chat_completion_stream"));
        assert!(!is_data_write("plugin:fs|read"));
        assert!(!is_data_write("devlog_set_backend_log_stream_enabled"));
    }
}
