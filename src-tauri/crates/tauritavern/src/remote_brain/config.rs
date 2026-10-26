//! Device-local PC Brain settings. They live beside the app config, not in the
//! shared SillyTavern settings, because each device has its own role.

use std::path::Path;

use serde::{Deserialize, Serialize};
use url::Url;

pub const DEFAULT_PORT: u16 = 8124;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostConfig {
    pub enabled: bool,
    pub port: u16,
    pub passcode: String,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            passcode: generate_passcode(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientConfig {
    pub enabled: bool,
    pub address: String,
    pub passcode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteBrainConfig {
    pub host: HostConfig,
    pub client: ClientConfig,
}

impl RemoteBrainConfig {
    /// Missing file means a fresh install: create it so the passcode stays stable.
    pub fn load_or_create(path: &Path) -> Self {
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<RemoteBrainConfig>(&bytes) {
                Ok(mut config) => {
                    config.normalize();
                    config
                }
                Err(error) => {
                    tracing::error!("PC Brain settings are unreadable, using defaults: {error}");
                    Self::default()
                }
            },
            Err(_) => {
                let config = Self::default();
                if let Err(error) = config.save(path) {
                    tracing::warn!("Could not save PC Brain settings: {error}");
                }
                config
            }
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn normalize(&mut self) {
        if self.host.port == 0 {
            self.host.port = DEFAULT_PORT;
        }
        self.host.passcode = self.host.passcode.trim().to_string();
        if self.host.passcode.is_empty() {
            self.host.passcode = generate_passcode();
        }
        self.client.address = self.client.address.trim().to_string();
        self.client.passcode = self.client.passcode.trim().to_string();
        // One role per device: a phone that reads from the PC never serves others.
        if self.client.enabled {
            self.host.enabled = false;
        }
    }

    pub fn client_target(&self) -> Option<ClientTarget> {
        if !self.client.enabled {
            return None;
        }
        let base = client_base_url(&self.client.address).ok()?;
        Some(ClientTarget {
            base,
            passcode: self.client.passcode.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct ClientTarget {
    pub base: Url,
    pub passcode: String,
}

impl ClientTarget {
    pub fn endpoint(&self, path: &str) -> String {
        let mut base = self.base.as_str().trim_end_matches('/').to_string();
        base.push_str(path);
        base
    }
}

/// Accepts what a person would type: `100.64.1.2`, `100.64.1.2:8124`,
/// `http://my-pc:8124/`, or a Tailscale machine name.
pub fn client_base_url(address: &str) -> Result<Url, String> {
    let trimmed = address.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Type your PC's Tailscale address first.".to_string());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| format!("\"{trimmed}\" is not an address"))?;
    if url.scheme() != "http" {
        return Err("The address should start with http:// (Tailscale already encrypts it).".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("\"{trimmed}\" is not an address"));
    }
    if url.port().is_none() {
        let _ = url.set_port(Some(DEFAULT_PORT));
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

const WORDS: [&str; 64] = [
    "amber", "apple", "aspen", "bear", "berry", "birch", "bloom", "brook", "cedar", "cloud",
    "clover", "comet", "coral", "daisy", "dawn", "delta", "dune", "ember", "fern", "finch",
    "flame", "fox", "frost", "glade", "harbor", "hazel", "heron", "honey", "iris", "ivy",
    "jade", "juniper", "lake", "lark", "lemon", "lotus", "maple", "meadow", "mint", "moon",
    "moss", "nova", "oak", "ocean", "olive", "orchid", "otter", "pearl", "pine", "plum",
    "rain", "raven", "river", "robin", "rose", "sage", "shell", "sky", "snow", "star",
    "stone", "sun", "tide", "willow",
];

pub fn generate_passcode() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let first = WORDS[(bytes[0] as usize) % WORDS.len()];
    let second = WORDS[(bytes[1] as usize) % WORDS.len()];
    let number = u16::from_le_bytes([bytes[2], bytes[3]]) % 900 + 100;
    format!("{first}-{second}-{number}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_addresses_become_base_urls() {
        assert_eq!(client_base_url("100.64.1.2").unwrap().as_str(), "http://100.64.1.2:8124/");
        assert_eq!(client_base_url(" 100.64.1.2:9000/ ").unwrap().as_str(), "http://100.64.1.2:9000/");
        assert_eq!(client_base_url("http://my-pc").unwrap().as_str(), "http://my-pc:8124/");
        assert!(client_base_url("").is_err());
        assert!(client_base_url("https://x").is_err());
    }

    #[test]
    fn passcodes_are_word_word_number() {
        let code = generate_passcode();
        assert_eq!(code.split('-').count(), 3);
    }
}
