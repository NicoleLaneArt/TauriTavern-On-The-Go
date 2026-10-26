//! Keeps the PC and the phone from overwriting each other's newer chat.
//!
//! A page holds a chat in memory from when it last read it. Saving the whole
//! chat from there puts back the old messages, so a full chat save is refused
//! when the *other* device saved that same chat after this device last read
//! it; the refused page reloads to the latest. Everything else (settings with
//! their own revision check, chat metadata, other chats) is never blocked.
//!
//! Separately, two counters of meaningful changes (chats and characters, not
//! settings) let a page reload when it comes back into view after the other
//! device changed something.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;
use tauri::ipc::InvokeBody;

/// Header the PC Brain server adds to every command it runs for the phone.
pub const FROM_PHONE_HEADER: &str = "x-tt-remote-brain";
/// Kept for older phone builds; no longer used for decisions.
pub const SEEN_PC_WRITES_HEADER: &str = "x-tt-remote-brain-seen";

pub const STALE_PHONE: &str = "PC Brain: this chat was changed on your PC since this page loaded it. Reloading to the latest so nothing is overwritten.";
pub const STALE_PC: &str = "PC Brain: this chat was changed on your phone since this window loaded it. Reloading to the latest so nothing is overwritten.";
pub const STALE_EVENT: &str = "remote-brain:stale";

static PC_WRITES: AtomicU64 = AtomicU64::new(0);
static PHONE_WRITES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Device {
    Pc,
    Phone,
}

#[derive(Default)]
struct ChatLedger {
    seq: u64,
    /// Last full save of each chat: who saved it and when.
    written: HashMap<String, (Device, u64)>,
    /// When each device last read (or itself wrote) each chat.
    seen: HashMap<(Device, String), u64>,
}

static LEDGER: Mutex<Option<ChatLedger>> = Mutex::new(None);

fn with_ledger<T>(f: impl FnOnce(&mut ChatLedger) -> T) -> T {
    let mut guard = LEDGER.lock().expect("PC Brain chat ledger");
    f(guard.get_or_insert_with(ChatLedger::default))
}

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

/// Kept as a hook for page loads; chat reads now carry the freshness.
pub fn pc_page_loaded() {}

fn str_arg<'a>(args: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    args.get(camel)
        .or_else(|| args.get(snake))
        .and_then(Value::as_str)
}

fn locator_key(target: &Value) -> Option<String> {
    match target.get("kind").and_then(Value::as_str)? {
        "character" => Some(format!(
            "c\u{1}{}\u{1}{}",
            str_arg(target, "characterId", "character_id")?,
            str_arg(target, "fileName", "file_name")?
        )),
        "group" => Some(format!("g\u{1}{}", str_arg(target, "chatId", "chat_id")?)),
        _ => None,
    }
}

enum ChatAccess {
    Read(String),
    FullWrite(String),
}

fn chat_access(command: &str, args: &Value) -> Option<ChatAccess> {
    match command {
        "get_chat_payload_path" => Some(ChatAccess::Read(format!(
            "c\u{1}{}\u{1}{}",
            str_arg(args, "characterName", "character_name")?,
            str_arg(args, "fileName", "file_name")?
        ))),
        "get_group_chat_path" => Some(ChatAccess::Read(format!("g\u{1}{}", str_arg(args, "id", "id")?))),
        "open_cold_chat" => Some(ChatAccess::Read(locator_key(args.get("target")?)?)),
        "begin_chat_commit" => {
            let kind = args.get("operation")?.get("kind").and_then(Value::as_str)?;
            (kind == "payload").then(|| locator_key(args.get("target")?).map(ChatAccess::FullWrite))?
        }
        _ => None,
    }
}

/// Runs before every app command. `Err` refuses a save from a stale page.
pub fn check_invoke(invoke: &tauri::ipc::Invoke<tauri::Wry>) -> Result<(), &'static str> {
    let command = invoke.message.command();
    let device = if invoke.message.headers().contains_key(FROM_PHONE_HEADER) {
        Device::Phone
    } else {
        Device::Pc
    };

    if let InvokeBody::Json(args) = invoke.message.payload()
        && let Some(access) = chat_access(command, args)
    {
        match access {
            ChatAccess::Read(key) => with_ledger(|ledger| {
                ledger.seq += 1;
                let seq = ledger.seq;
                ledger.seen.insert((device, key), seq);
            }),
            ChatAccess::FullWrite(key) => {
                let stale = with_ledger(|ledger| {
                    let seen = ledger.seen.get(&(device, key.clone())).copied().unwrap_or(0);
                    let newer_elsewhere = matches!(
                        ledger.written.get(&key),
                        Some((writer, at)) if *writer != device && *at > seen
                    );
                    if !newer_elsewhere {
                        ledger.seq += 1;
                        let seq = ledger.seq;
                        ledger.written.insert(key.clone(), (device, seq));
                        ledger.seen.insert((device, key), seq);
                    }
                    newer_elsewhere
                });
                if stale {
                    return Err(match device {
                        Device::Phone => STALE_PHONE,
                        Device::Pc => {
                            let _ = invoke.message.webview_ref().emit_to(
                                tauri::EventTarget::webview_window("main"),
                                STALE_EVENT,
                                STALE_PC,
                            );
                            STALE_PC
                        }
                    });
                }
            }
        }
    }

    if counts_as_change(command, invoke.message.payload()) {
        match device {
            Device::Phone => PHONE_WRITES.fetch_add(1, Ordering::SeqCst),
            Device::Pc => PC_WRITES.fetch_add(1, Ordering::SeqCst),
        };
    }
    Ok(())
}

/// Changes worth reloading the other device for: chats and characters.
/// Settings, quick replies and chat metadata are saved on every page load
/// and would make each device reload the other for nothing.
fn counts_as_change(command: &str, body: &InvokeBody) -> bool {
    if command == "begin_chat_commit" {
        return matches!(
            body,
            InvokeBody::Json(args)
                if args.get("operation").and_then(|o| o.get("kind")).and_then(Value::as_str) == Some("payload")
        );
    }
    matches!(
        command,
        "delete_chat"
            | "rename_chat"
            | "add_message"
            | "import_chat"
            | "import_character_chats"
            | "delete_group_chat"
            | "rename_group_chat"
            | "import_group_chat_payload"
            | "create_character"
            | "create_character_with_avatar"
            | "update_character"
            | "update_character_card_data"
            | "delete_character"
            | "rename_character"
            | "duplicate_character"
            | "import_character"
            | "replace_character"
            | "update_avatar"
            | "create_group"
            | "update_group"
            | "delete_group"
            | "finish_world_info_commit"
            | "delete_world_info"
            | "import_world_info"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_and_writes_share_keys() {
        let read = chat_access(
            "get_chat_payload_path",
            &json!({"characterName": "Tanner", "fileName": "chat 1"}),
        );
        let write = chat_access(
            "begin_chat_commit",
            &json!({"target": {"kind": "character", "characterId": "Tanner", "fileName": "chat 1"}, "operation": {"kind": "payload", "force": false}}),
        );
        let (Some(ChatAccess::Read(a)), Some(ChatAccess::FullWrite(b))) = (read, write) else {
            panic!("expected read and write");
        };
        assert_eq!(a, b);
        assert!(chat_access(
            "begin_chat_commit",
            &json!({"target": {"kind": "group", "chatId": "g"}, "operation": {"kind": "metadata"}}),
        )
        .is_none());
    }
}
