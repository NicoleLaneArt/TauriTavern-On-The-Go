//! Phone side: sends commands and picture requests to the PC.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;
use tauri::http::{Request, Response, StatusCode, header};
use tt_application::services::host_resource_service::{
    HostResourceDeliveryCapabilities, HostResourceResponse,
};

use super::config::ClientTarget;
use super::server::{
    ARG_HEADERS_HEADER, CMD_HEADER, DELIVERY_HEADER, KEY_HEADER, RESULT_HEADER,
};

pub const OFFLINE_PREFIX: &str = "PC offline";

pub enum ForwardBody {
    Json(Value),
    Raw(Vec<u8>),
}

pub enum ForwardResult {
    Json(String),
    Raw(Vec<u8>),
}

/// Runs one command on the PC. `Err` carries the PC command's own error value,
/// or a "PC offline" string when the PC could not be reached.
pub async fn forward(
    http: &reqwest::Client,
    target: &ClientTarget,
    command: &str,
    body: ForwardBody,
    headers: &HashMap<String, String>,
) -> Result<ForwardResult, Value> {
    let mut request = http
        .post(target.endpoint("/brain/invoke"))
        .header(KEY_HEADER, &target.passcode)
        .header(CMD_HEADER, command);
    if !headers.is_empty() {
        let encoded = serde_json::to_string(headers).unwrap_or_default();
        request = request.header(ARG_HEADERS_HEADER, encoded);
    }
    request = match body {
        ForwardBody::Json(value) => request
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec())),
        ForwardBody::Raw(bytes) => request
            .header(header::CONTENT_TYPE.as_str(), "application/octet-stream")
            .body(bytes),
    };

    let response = request.send().await.map_err(offline_error)?;
    let status = response.status();
    let result = response
        .headers()
        .get(RESULT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE.as_str())
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    let bytes = response.bytes().await.map_err(offline_error)?;

    match (status.as_u16(), result.as_deref()) {
        (200, Some("ok")) if is_json => Ok(ForwardResult::Json(
            String::from_utf8_lossy(&bytes).into_owned(),
        )),
        (200, Some("ok")) => Ok(ForwardResult::Raw(bytes.to_vec())),
        (200, Some("err")) => Err(serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))),
        (401, _) => Err(Value::String(
            "PC Brain: wrong passcode. Check it in the PC Brain panel.".to_string(),
        )),
        (403, _) => Err(Value::String(
            "PC Brain: the PC only answers over Tailscale. Is Tailscale on?".to_string(),
        )),
        _ => Err(Value::String(format!(
            "{OFFLINE_PREFIX}: {}",
            String::from_utf8_lossy(&bytes).trim()
        ))),
    }
}

fn offline_error(error: reqwest::Error) -> Value {
    let reason = if error.is_connect() || error.is_timeout() {
        "can't reach it. Is the PC awake, with TauriTavern and Tailscale running?".to_string()
    } else {
        error.to_string()
    };
    Value::String(format!("{OFFLINE_PREFIX}: {reason}"))
}

pub async fn hello(http: &reqwest::Client, target: &ClientTarget) -> Result<Value, String> {
    let response = http
        .get(target.endpoint("/brain/hello"))
        .header(KEY_HEADER, &target.passcode)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|error| match offline_error(error) {
            Value::String(s) => s,
            other => other.to_string(),
        })?;
    match response.status().as_u16() {
        200 => response.json::<Value>().await.map_err(|e| e.to_string()),
        401 => Err("Wrong passcode. Copy it from the PC Brain panel on your PC.".to_string()),
        403 => Err("The PC only answers over Tailscale. Turn Tailscale on.".to_string()),
        code => Err(format!("{OFFLINE_PREFIX}: the PC answered {code}")),
    }
}

/// Picture and file requests the webview makes on the phone. Returns `None`
/// when this device is not reading from a PC.
pub(crate) fn proxy_host_resource(
    request: &Request<Vec<u8>>,
    delivery: HostResourceDeliveryCapabilities,
) -> Option<HostResourceResponse> {
    let brain = super::brain()?;
    let target = brain.client_target()?;
    let http = brain.http.clone();

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = target.endpoint(&format!("/brain/res{path_and_query}"));
    let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let mut forwarded = Vec::new();
    for name in ["if-none-match", "if-modified-since", "range", "if-range", "accept"] {
        if let Some(value) = request.headers().get(name) {
            forwarded.push((name, value.as_bytes().to_vec()));
        }
    }

    // The webview calls us on a thread outside the async runtime; run the
    // request on a scratch thread so this works from any caller.
    let fetched = std::thread::spawn(move || {
        tauri::async_runtime::block_on(async move {
            let mut builder = http
                .request(method, url)
                .header(KEY_HEADER, &target.passcode)
                .header(DELIVERY_HEADER, delivery.to_wire())
                .timeout(Duration::from_secs(60));
            for (name, value) in forwarded {
                builder = builder.header(name, value);
            }
            let response = builder.send().await?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let body = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, headers, body))
        })
    })
    .join();

    Some(match fetched {
        Ok(Ok((status, headers, body))) => {
            let mut response = Response::builder()
                .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY));
            for (name, value) in headers.iter() {
                let lower = name.as_str();
                if matches!(lower, "connection" | "transfer-encoding" | "keep-alive") {
                    continue;
                }
                response = response.header(lower, value.as_bytes());
            }
            response
                .body(body.to_vec())
                .unwrap_or_else(|_| unavailable("bad response from PC"))
        }
        Ok(Err(error)) => unavailable(&format!("{OFFLINE_PREFIX}: {error}")),
        Err(_) => unavailable("PC Brain picture request failed"),
    })
}

fn unavailable(message: &str) -> HostResourceResponse {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header("cache-control", "no-store")
        .header("content-type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("static response")
}
