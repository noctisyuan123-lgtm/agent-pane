use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

struct BridgeProcess(Mutex<Option<Child>>);

/// Build a PATH safe for agent tool shells when the app is launched from Dock
/// (lean GUI PATH). Always keeps system bins; drops broken tokens like `$`.
fn build_healthy_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if p.is_empty() || p == "$" {
            return;
        }
        if !parts.iter().any(|x| x == &p) {
            parts.push(p);
        }
    };

    if let Ok(existing) = std::env::var("PATH") {
        for p in existing.split(':') {
            let t = p.trim();
            if !t.is_empty() && t != "$" {
                push(t.to_string());
            }
        }
    }

    for extra in [
        format!("{home}/.grok/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
    ] {
        if extra.starts_with('/') || std::path::Path::new(&extra).exists() {
            push(extra);
        }
    }

    // Absolute guarantee for system bins
    for sys in [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
    ] {
        push(sys.to_string());
    }

    parts.join(":")
}

#[cfg(target_os = "macos")]
fn apply_window_glass(window: &tauri::WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    // Sidebar material ≈ GrokBuild `List.listStyle(.sidebar)` vibrancy.
    // Needs app.macOSPrivateApi + tauri feature macos-private-api so the
    // WKWebView is actually transparent; otherwise CSS alpha is opaque-on-black.
    match apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    ) {
        Ok(()) => eprintln!("[agent-pane] vibrancy Sidebar applied"),
        Err(e) => eprintln!("[agent-pane] vibrancy failed: {e}"),
    }
}

/// Session id requested via CLI (`--session=` / `open <id>`). Consumed on Ready + events.
struct PendingOpenSession(Mutex<Option<String>>);

#[derive(Clone, serde::Serialize)]
struct OpenSessionPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
}

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
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/bridge.cjs");
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
        // Wave 4: shared `grok agent serve` (override with AGENT_PANE_PROVIDER=stdio)
        .env(
            "AGENT_PANE_PROVIDER",
            std::env::var("AGENT_PANE_PROVIDER").unwrap_or_else(|_| "serve".into()),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Native modules (node-pty / playwright) resolve from monorepo node_modules
    let repo_nm = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../node_modules");
    if repo_nm.exists() {
        if let Ok(abs) = repo_nm.canonicalize() {
            cmd.env("NODE_PATH", abs);
        }
    }

    // Tell bridge where browser-mcp.cjs lives (next to bridge.cjs)
    if let Some(parent) = script.parent() {
        cmd.env("AGENT_PANE_BRIDGE_DIR", parent);
        let mcp = parent.join("browser-mcp.cjs");
        if mcp.exists() {
            cmd.env("AGENT_PANE_BROWSER_MCP", mcp);
        } else {
            let mcp2 = parent.join("resources/browser-mcp.cjs");
            if mcp2.exists() {
                cmd.env("AGENT_PANE_BROWSER_MCP", mcp2);
            }
        }
    }

    // Healthy PATH for bridge → grok agent → tool shells (Dock launches are lean).
    cmd.env("PATH", build_healthy_path());

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
                // SIGTERM first so Node can run DaemonSupervisor.shutdown()
                // and kill `grok agent serve` — Child::kill is SIGKILL and leaves orphans on :2419.
                #[cfg(unix)]
                {
                    let pid = child.id();
                    let _ = std::process::Command::new("kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Parse `--session=<id>`, `--session <id>`, or `open <id>` from argv.
fn parse_session_arg(args: &[String]) -> Option<String> {
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        if let Some(v) = a.strip_prefix("--session=") {
            let id = v.trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        if a == "--session" {
            if let Some(v) = args.get(i + 1) {
                let id = v.trim();
                if !id.is_empty() && !id.starts_with('-') {
                    return Some(id.to_string());
                }
            }
        }
        if a == "open" {
            if let Some(v) = args.get(i + 1) {
                let id = v.trim();
                if !id.is_empty() && !id.starts_with('-') {
                    return Some(id.to_string());
                }
            }
        }
        i += 1;
    }
    None
}

fn focus_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn emit_open_session(app: &AppHandle, session_id: &str) {
    focus_main_window(app);
    let _ = app.emit(
        "open-session",
        OpenSessionPayload {
            session_id: session_id.to_string(),
        },
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_args: Vec<String> = std::env::args().collect();
    let launch_session = parse_session_arg(&launch_args);

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(session_id) = parse_session_arg(&argv) {
                eprintln!("[agent-pane] single-instance open-session {session_id}");
                emit_open_session(app, &session_id);
            } else {
                focus_main_window(app);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .manage(BridgeProcess(Mutex::new(None)))
        .manage(PendingOpenSession(Mutex::new(launch_session)))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                apply_window_glass(&window);
                // Clear webview fill so NSVisualEffect shows through CSS glass layers.
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            }
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
            match event {
                RunEvent::Ready => {
                    // Cold start: deliver --session= after webview is up (retry once).
                    let pending = app_handle
                        .try_state::<PendingOpenSession>()
                        .and_then(|s| s.0.lock().ok()?.take());
                    if let Some(session_id) = pending {
                        eprintln!("[agent-pane] cold-start open-session {session_id}");
                        let app2 = app_handle.clone();
                        let id2 = session_id.clone();
                        emit_open_session(app_handle, &session_id);
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1200));
                            emit_open_session(&app2, &id2);
                        });
                    }
                }
                RunEvent::Exit => {
                    stop_bridge(app_handle);
                }
                _ => {}
            }
        });
}
