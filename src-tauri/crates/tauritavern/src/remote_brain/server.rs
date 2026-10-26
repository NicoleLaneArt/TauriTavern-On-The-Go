//! PC side: answers the phone over Tailscale.

use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager};
use tt_application::services::host_resource_service::{
    HostResourceDeliveryCapabilities, HostResourceService,
};

use super::writes::{self, FROM_PHONE_HEADER};

pub const KEY_HEADER: &str = "x-brain-key";
pub const CMD_HEADER: &str = "x-brain-cmd";
pub const ARG_HEADERS_HEADER: &str = "x-brain-headers";
pub const RESULT_HEADER: &str = "x-brain-result";
pub const DELIVERY_HEADER: &str = "x-brain-delivery";

#[derive(Default)]
pub struct ServerState {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    pub running_port: Option<u16>,
    pub error: Option<String>,
}

struct Ctx {
    app: AppHandle,
    passcode: String,
}

pub fn stop(state: &Mutex<ServerState>) {
    let mut state = state.lock().expect("PC Brain server lock");
    if let Some(shutdown) = state.shutdown.take() {
        let _ = shutdown.send(());
    }
    state.running_port = None;
    state.error = None;
}

pub async fn start(state: &Mutex<ServerState>, app: AppHandle, port: u16, passcode: String) {
    // A restart may race the previous listener's release; retry briefly.
    let mut last_error = String::new();
    let mut listener = None;
    for _ in 0..10 {
        match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(error) => {
                last_error = error.to_string();
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }
    let Some(listener) = listener else {
        let message = format!("Port {port} is busy or blocked: {last_error}");
        tracing::error!("PC Brain server could not start: {message}");
        state.lock().expect("PC Brain server lock").error = Some(message);
        return;
    };

    let ctx = Arc::new(Ctx { app, passcode });
    let router = Router::new()
        .route("/brain/hello", get(hello))
        .route("/brain/invoke", post(invoke))
        .route("/brain/res/{*path}", get(resource).head(resource))
        .with_state(ctx);

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let service = router.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(error) = axum::serve(listener, service)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
        {
            tracing::error!("PC Brain server stopped: {error}");
        }
    });

    let mut state = state.lock().expect("PC Brain server lock");
    state.shutdown = Some(tx);
    state.running_port = Some(port);
    state.error = None;
    tracing::info!("PC Brain server listening on port {port} (Tailscale and this PC only)");
}

/// Only this PC and devices on the Tailscale network may connect.
fn is_allowed_peer(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        other => other,
    };
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback() || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback() || (s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0)
        }
    }
}

async fn check(ctx: &Ctx, peer: SocketAddr, headers: &HeaderMap) -> Result<(), Response> {
    if !is_allowed_peer(peer.ip()) {
        return Err((
            StatusCode::FORBIDDEN,
            "PC Brain only answers devices on your Tailscale network",
        )
            .into_response());
    }
    let given = headers
        .get(KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !constant_time_eq(given.trim().as_bytes(), ctx.passcode.as_bytes()) {
        tokio::time::sleep(Duration::from_millis(700)).await;
        return Err((StatusCode::UNAUTHORIZED, "Wrong PC Brain passcode").into_response());
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn hello(
    State(ctx): State<Arc<Ctx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(denied) = check(&ctx, peer, &headers).await {
        return denied;
    }
    let counters = writes::counters();
    axum::Json(json!({
        "app": "TauriTavern PC Brain",
        "name": machine_name(),
        "version": ctx.app.package_info().version.to_string(),
        "pcWrites": counters.pc_writes,
        "phoneWrites": counters.phone_writes,
    }))
    .into_response()
}

pub fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "PC".to_string())
}

/// Commands the phone may never run on the PC, even with the passcode.
fn is_refused(command: &str) -> bool {
    if let Some(plugin) = command.strip_prefix("plugin:") {
        return !matches!(
            plugin,
            "fs|open" | "fs|fstat" | "fs|read" | "fs|seek" | "fs|stat" | "resources|close"
        );
    }
    command.starts_with("remote_brain_")
        || command.starts_with("lan_sync_")
        || command.starts_with("tt_sync_")
        || command.starts_with("sync_")
        || matches!(
            command,
            "set_data_root"
                | "import_data_archive_from_picker"
                | "pick_import_files"
                | "deliver_staged_file"
                | "devlog_export_bundle"
                | "set_window_backdrop"
                | "capture_content_viewport"
        )
}

fn fs_open_is_read_only(body: &InvokeBody) -> bool {
    let InvokeBody::Json(value) = body else {
        return false;
    };
    let Some(options) = value.get("options") else {
        return true;
    };
    ["write", "append", "truncate", "create", "createNew"]
        .iter()
        .all(|flag| !options.get(*flag).and_then(|v| v.as_bool()).unwrap_or(false))
}

async fn invoke(
    State(ctx): State<Arc<Ctx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(denied) = check(&ctx, peer, &headers).await {
        return denied;
    }
    let Some(command) = headers
        .get(CMD_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return (StatusCode::BAD_REQUEST, "missing command").into_response();
    };

    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    let invoke_body = if is_json {
        match serde_json::from_slice(&body) {
            Ok(value) => InvokeBody::Json(value),
            Err(error) => {
                return (StatusCode::BAD_REQUEST, format!("bad arguments: {error}")).into_response();
            }
        }
    } else {
        InvokeBody::Raw(body.to_vec())
    };

    if is_refused(&command) || (command == "plugin:fs|open" && !fs_open_is_read_only(&invoke_body))
    {
        return command_error(json!(format!(
            "PC Brain: \"{command}\" only works on the device itself"
        )));
    }

    let mut invoke_headers = forwarded_headers(&headers);
    invoke_headers.insert(
        HeaderName::from_static(FROM_PHONE_HEADER),
        HeaderValue::from_static("1"),
    );

    match dispatch(&ctx.app, command, invoke_body, invoke_headers).await {
        Ok(InvokeResponse::Ok(InvokeResponseBody::Json(json))) => Response::builder()
            .header(RESULT_HEADER, "ok")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json))
            .expect("response"),
        Ok(InvokeResponse::Ok(InvokeResponseBody::Raw(bytes))) => Response::builder()
            .header(RESULT_HEADER, "ok")
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(Body::from(bytes))
            .expect("response"),
        Ok(InvokeResponse::Err(error)) => command_error(error.0),
        Err(message) => (StatusCode::SERVICE_UNAVAILABLE, message).into_response(),
    }
}

fn command_error(value: serde_json::Value) -> Response {
    Response::builder()
        .header(RESULT_HEADER, "err")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .expect("response")
}

fn forwarded_headers(headers: &HeaderMap) -> tauri::http::HeaderMap {
    let mut out = tauri::http::HeaderMap::new();
    let Some(raw) = headers.get(ARG_HEADERS_HEADER).and_then(|v| v.to_str().ok()) else {
        return out;
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return out;
    };
    for (name, value) in map {
        let (Ok(name), Some(Ok(value))) = (
            tauri::http::HeaderName::from_str(&name.to_ascii_lowercase()),
            value.as_str().map(tauri::http::HeaderValue::from_str),
        ) else {
            continue;
        };
        out.insert(name, value);
    }
    out
}

/// Runs a command through the PC's main webview IPC path, exactly as the PC
/// frontend would, and returns Tauri's own response.
async fn dispatch(
    app: &AppHandle,
    command: String,
    body: InvokeBody,
    headers: tauri::http::HeaderMap,
) -> Result<InvokeResponse, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The PC's TauriTavern window is still starting".to_string())?;
    let url = window.url().map_err(|e| e.to_string())?;
    let request = InvokeRequest {
        cmd: command,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body,
        headers,
        invoke_key: app.invoke_key().to_string(),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        window.on_message(
            request,
            Box::new(move |_webview, _cmd, response, _callback, _error| {
                let _ = tx.send(response);
            }),
        );
    });
    rx.await
        .map_err(|_| "The PC dropped the request".to_string())
}

async fn resource(
    State(ctx): State<Arc<Ctx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if let Err(denied) = check(&ctx, peer, &headers).await {
        return denied;
    }
    let path = uri.path().strip_prefix("/brain/res").unwrap_or("/");
    let target = match uri.query() {
        Some(query) => format!("tauri://localhost{path}?{query}"),
        None => format!("tauri://localhost{path}"),
    };
    let mut builder = tauri::http::Request::builder()
        .method(method.as_str())
        .uri(target);
    for name in [
        header::IF_NONE_MATCH,
        header::IF_MODIFIED_SINCE,
        header::RANGE,
        header::IF_RANGE,
        header::ACCEPT,
    ] {
        if let Some(value) = headers.get(&name) {
            builder = builder.header(name.as_str(), value.as_bytes());
        }
    }
    let Ok(request) = builder.body(Vec::new()) else {
        return (StatusCode::BAD_REQUEST, "bad resource request").into_response();
    };
    let delivery = headers
        .get(DELIVERY_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(HostResourceDeliveryCapabilities::from_wire)
        .unwrap_or(HostResourceDeliveryCapabilities::new(false, false));

    let Some(service) = ctx.app.try_state::<Arc<HostResourceService>>().map(|s| s.inner().clone())
    else {
        return (StatusCode::SERVICE_UNAVAILABLE, "PC is still starting").into_response();
    };
    let served =
        tauri::async_runtime::spawn_blocking(move || service.serve(&request, delivery)).await;
    let Ok(served) = served else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "resource task failed").into_response();
    };

    let (parts, body) = served.into_parts();
    let mut response = Response::builder().status(parts.status.as_u16());
    for (name, value) in parts.headers.iter() {
        response = response.header(name.as_str(), value.as_bytes());
    }
    response.body(Body::from(body)).expect("response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tailscale_and_loopback_peers() {
        assert!(is_allowed_peer("100.101.102.103".parse().unwrap()));
        assert!(is_allowed_peer("127.0.0.1".parse().unwrap()));
        assert!(is_allowed_peer("fd7a:115c:a1e0::1".parse().unwrap()));
        assert!(!is_allowed_peer("192.168.1.20".parse().unwrap()));
        assert!(!is_allowed_peer("100.128.0.1".parse().unwrap()));
        assert!(!is_allowed_peer("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn refuses_device_only_commands() {
        assert!(is_refused("set_data_root"));
        assert!(is_refused("plugin:dialog|open"));
        assert!(!is_refused("plugin:fs|read"));
        assert!(!is_refused("get_bootstrap_metadata"));
        assert!(!is_refused("finish_chat_commit"));
    }
}
