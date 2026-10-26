//! Device-local commands. The phone frontend never forwards these to the PC.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::ipc::{Request, Response};

use super::client::{self, ForwardBody, ForwardResult};
use super::config::{RemoteBrainConfig, client_base_url};
use super::server::{ARG_HEADERS_HEADER, CMD_HEADER, machine_name};
use super::{ClientTarget, brain, writes};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAddress {
    pub ip: String,
    pub tailscale: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBrainState {
    pub config: RemoteBrainConfig,
    pub host_running: bool,
    pub host_error: Option<String>,
    pub host_addresses: Vec<HostAddress>,
    pub machine_name: String,
    pub pc_writes: u64,
    pub phone_writes: u64,
}

fn state() -> Result<RemoteBrainState, String> {
    let brain = brain().ok_or("PC Brain is unavailable on this device")?;
    let server = brain.server.lock().expect("PC Brain server lock");
    let counters = writes::counters();
    Ok(RemoteBrainState {
        config: brain.config(),
        host_running: server.running_port.is_some(),
        host_error: server.error.clone(),
        host_addresses: host_addresses(),
        machine_name: machine_name(),
        pc_writes: counters.pc_writes,
        phone_writes: counters.phone_writes,
    })
}

fn host_addresses() -> Vec<HostAddress> {
    let mut out: Vec<HostAddress> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|iface| !iface.is_loopback())
        .filter_map(|iface| match iface.ip() {
            std::net::IpAddr::V4(v4) => {
                let [a, b, ..] = v4.octets();
                Some(HostAddress {
                    ip: v4.to_string(),
                    tailscale: a == 100 && (64..=127).contains(&b),
                })
            }
            std::net::IpAddr::V6(_) => None,
        })
        .collect();
    out.sort_by_key(|a| !a.tailscale);
    out
}

#[tauri::command]
pub fn remote_brain_get_state() -> Result<RemoteBrainState, String> {
    state()
}

#[tauri::command]
pub async fn remote_brain_save_config(config: RemoteBrainConfig) -> Result<RemoteBrainState, String> {
    let brain = brain().ok_or("PC Brain is unavailable on this device")?;
    brain.save_config(config).await?;
    state()
}

/// Checks a PC before saving it (address and passcode as typed), or the saved
/// PC when both are omitted.
#[tauri::command]
pub async fn remote_brain_check(
    address: Option<String>,
    passcode: Option<String>,
) -> Result<Value, String> {
    let brain = brain().ok_or("PC Brain is unavailable on this device")?;
    let target = match (address, passcode) {
        (Some(address), Some(passcode)) => ClientTarget {
            base: client_base_url(&address)?,
            passcode: passcode.trim().to_string(),
        },
        _ => brain
            .client_target()
            .ok_or("This device is not set to read from a PC")?,
    };
    let mut hello = client::hello(&brain.http, &target).await?;
    if let Value::Object(map) = &mut hello {
        map.insert("address".to_string(), json!(target.base.as_str()));
    }
    Ok(hello)
}

fn into_response(result: Result<ForwardResult, Value>) -> Result<Response, Value> {
    match result? {
        ForwardResult::Json(json) => Ok(Response::new(json)),
        ForwardResult::Raw(bytes) => Ok(Response::new(bytes)),
    }
}

fn client() -> Result<(&'static super::RemoteBrain, ClientTarget), Value> {
    let brain = brain().ok_or_else(|| json!("PC Brain is unavailable on this device"))?;
    let target = brain
        .client_target()
        .ok_or_else(|| json!("This device is not set to read from a PC"))?;
    Ok((brain.as_ref(), target))
}

#[tauri::command]
pub async fn remote_brain_forward(
    cmd: String,
    args: Option<Value>,
    headers: Option<HashMap<String, String>>,
) -> Result<Response, Value> {
    let (brain, target) = client()?;
    let body = ForwardBody::Json(args.unwrap_or_else(|| json!({})));
    into_response(
        client::forward(&brain.http, &target, &cmd, body, &headers.unwrap_or_default()).await,
    )
}

/// Byte arguments (desktop chunk uploads) arrive as a raw body; the command and
/// its headers ride in request headers.
#[tauri::command]
pub async fn remote_brain_forward_raw(request: Request<'_>) -> Result<Response, Value> {
    let (brain, target) = client()?;
    let command = request
        .headers()
        .get(CMD_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| json!("missing command"))?
        .to_string();
    let headers: HashMap<String, String> = request
        .headers()
        .get(ARG_HEADERS_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => ForwardBody::Raw(bytes.clone()),
        tauri::ipc::InvokeBody::Json(value) => ForwardBody::Json(value.clone()),
    };
    into_response(client::forward(&brain.http, &target, &command, body, &headers).await)
}
