//! PC Brain: one TauriTavern (the PC, "host") keeps all the data; another (the
//! phone, "client") runs the same app but sends its data commands and picture
//! requests to the PC over Tailscale.
//!
//! - Host: a small HTTP server runs each forwarded command through the PC's own
//!   main webview IPC path, so the PC answers exactly as it answers itself.
//! - Client: the frontend routes data commands to `remote_brain_forward`, and the
//!   web-resource handler fetches host resources (avatars, thumbnails,
//!   backgrounds, extension files) from the PC.

mod client;
pub(crate) mod commands;
mod config;
mod server;
mod writes;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};

pub(crate) use client::proxy_host_resource;
pub(crate) use config::{ClientTarget, RemoteBrainConfig};
pub(crate) use writes::note_invoke;

const CONFIG_FILE: &str = "pc-brain.json";

static BRAIN: OnceLock<Arc<RemoteBrain>> = OnceLock::new();

pub(crate) struct RemoteBrain {
    app: AppHandle,
    config_path: PathBuf,
    config: RwLock<RemoteBrainConfig>,
    server: Mutex<server::ServerState>,
    http: reqwest::Client,
}

pub(crate) fn brain() -> Option<&'static Arc<RemoteBrain>> {
    BRAIN.get()
}

/// Loads this device's role and starts the PC server when enabled. Must run
/// before the main window exists so picture requests already know the role.
pub(crate) fn install(app: &tauri::App) {
    let handle = app.handle().clone();
    let config_path = match handle.path().app_config_dir() {
        Ok(dir) => dir.join(CONFIG_FILE),
        Err(error) => {
            tracing::error!("PC Brain disabled: no app config directory ({error})");
            return;
        }
    };
    let config = RemoteBrainConfig::load_or_create(&config_path);
    let http = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(6))
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .expect("PC Brain HTTP client");

    let brain = Arc::new(RemoteBrain {
        app: handle,
        config_path,
        config: RwLock::new(config),
        server: Mutex::new(server::ServerState::default()),
        http,
    });
    if BRAIN.set(brain.clone()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move { brain.apply_host().await });
}

impl RemoteBrain {
    pub(crate) fn config(&self) -> RemoteBrainConfig {
        self.config.read().expect("PC Brain config lock").clone()
    }

    pub(crate) fn client_target(&self) -> Option<ClientTarget> {
        self.config.read().expect("PC Brain config lock").client_target()
    }

    pub(crate) async fn save_config(&self, mut next: RemoteBrainConfig) -> Result<(), String> {
        next.normalize();
        if next.client.enabled {
            config::client_base_url(&next.client.address)?;
            if next.client.passcode.is_empty() {
                return Err("Type the PC's passcode first.".to_string());
            }
        }
        next.save(&self.config_path)?;
        *self.config.write().expect("PC Brain config lock") = next;
        self.apply_host().await;
        Ok(())
    }

    async fn apply_host(&self) {
        let host = self.config().host;
        server::stop(&self.server);
        if host.enabled {
            server::start(&self.server, self.app.clone(), host.port, host.passcode).await;
        }
    }
}
