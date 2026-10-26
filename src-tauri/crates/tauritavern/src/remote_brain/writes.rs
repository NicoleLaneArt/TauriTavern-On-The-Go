//! Change counters so each device knows when the other one changed the data.
//!
//! A page that loaded before the other device saved holds stale chats in memory;
//! saving from it would overwrite the newer file. The frontend compares these
//! counters when it comes back into view and reloads if the other side wrote.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

/// Header the PC Brain server adds to every command it runs for the phone.
pub const FROM_PHONE_HEADER: &str = "x-tt-remote-brain";

static PC_WRITES: AtomicU64 = AtomicU64::new(0);
static PHONE_WRITES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCounters {
    pub pc_writes: u64,
    pub phone_writes: u64,
}

pub fn counters() -> WriteCounters {
    WriteCounters {
        pc_writes: PC_WRITES.load(Ordering::Relaxed),
        phone_writes: PHONE_WRITES.load(Ordering::Relaxed),
    }
}

pub fn note_invoke(invoke: &tauri::ipc::Invoke<tauri::Wry>) {
    if !is_data_write(invoke.message.command()) {
        return;
    }
    if invoke.message.headers().contains_key(FROM_PHONE_HEADER) {
        PHONE_WRITES.fetch_add(1, Ordering::Relaxed);
    } else {
        PC_WRITES.fetch_add(1, Ordering::Relaxed);
    }
}

const WRITE_PREFIXES: &[&str] = &[
    "add_", "adopt_", "append_", "assign_", "backup_", "bulk_", "create_", "delete_",
    "duplicate_", "finish_", "import_", "merge_", "move_", "rename_", "replace_",
    "resolve_character_lorebook", "restore_", "rotate_", "save_", "set_", "unassign_",
    "update_", "upload_", "write_",
];

const NOT_DATA: &[&str] = &[
    "set_window_backdrop",
    "set_data_root",
    "set_agent_extension_tool_enabled",
    "append_chat_commit_chunk",
    "append_settings_commit_chunk",
    "append_world_info_commit_chunk",
    "append_extension_store_commit_chunk",
    "save_export_data_archive",
];

fn is_data_write(command: &str) -> bool {
    !command.starts_with("plugin:")
        && !command.starts_with("remote_brain_")
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
        assert!(!is_data_write("read_chat_completion_stream"));
        assert!(!is_data_write("plugin:fs|read"));
    }
}
