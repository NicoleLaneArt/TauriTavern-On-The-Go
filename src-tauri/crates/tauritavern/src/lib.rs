mod app;
mod infrastructure;
mod observability_targets;
mod platform;
mod presentation;
mod product;
mod remote_brain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::host::run();
}
