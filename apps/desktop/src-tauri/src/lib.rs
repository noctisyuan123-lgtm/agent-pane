use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

struct BridgeProcess(Mutex<Option<Child>>);

fn find_node() -> String {
    // Prefer explicit env, then common paths, then PATH
    if let Ok(p) = std::env::var("AGENT_PANE_NODE") {
        return p;
    }
    for cand in [
        "/Users/maybach/.nvm/versions/node/v22.22.2/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ] {
        if std::path::Path::new(cand).exists() {
            return cand.to_string();
        }
    }
    "node".to_string()
}

fn bridge_script_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // Dev: apps/desktop/sidecar/bridge.cjs next to package
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../sidecar/bridge.cjs");
    if dev.exists() {
        return Some(dev.canonicalize().unwrap_or(dev));
    }
    // Production: resource dir
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("bridge.cjs");
        if p.exists() {
            return Some(p);
        }
        // nested resources/
        let p2 = dir.join("resources/bridge.cjs");
        if p2.exists() {
            return Some(p2);
        }
    }
    None
}

fn start_bridge(app: &tauri::AppHandle) -> Result<(), String> {
    let script = bridge_script_path(app)
        .ok_or_else(|| "bridge.cjs not found — run npm run bundle:bridge first".to_string())?;
    let node = find_node();

    // Ensure GROK is on PATH for the child
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("AGENT_PANE_PORT", "8787")
        .env("AGENT_PANE_HOST", "127.0.0.1")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // prepend common grok/bin paths
    if let Ok(home) = std::env::var("HOME") {
        let grok_bin = format!("{home}/.grok/bin");
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{grok_bin}:{path}"));
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn bridge ({node} {}): {e}", script.display()))?;

    if let Some(state) = app.try_state::<BridgeProcess>() {
        *state.0.lock().unwrap() = Some(child);
    }

    Ok(())
}

fn stop_bridge(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BridgeProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BridgeProcess(Mutex::new(None)))
        .setup(|app| {
            if let Err(e) = start_bridge(app.handle()) {
                eprintln!("[agent-pane] {e}");
            } else {
                eprintln!("[agent-pane] bridge started on 127.0.0.1:8787");
            }
            // brief wait so first health check can succeed
            std::thread::sleep(std::time::Duration::from_millis(400));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                stop_bridge(app_handle);
            }
        });
}
