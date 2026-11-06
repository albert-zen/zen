mod capture;
mod ipc;
mod protocols;
#[cfg(test)]
mod transport_tests;

use std::{error::Error, io::Write, path::Path};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn emit(value: serde_json::Value) -> Result<()> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}

/// Metadata of the captured window, or none if it changed while the capture ran.
fn captured_metadata(captured: &ipc::Window, after: Vec<ipc::Window>) -> Option<serde_json::Value> {
    // Never pair text with a different/closed window or stale geometry.
    after
        .into_iter()
        .find(|w| w.address == captured.address)
        .filter(|w| captured.matches_after_capture(w))
        .map(|_| captured.metadata())
}

const PROTOCOL_VERSION: u32 = 1;
const BUILD_ID: &str = "zenx-hyprland-core-v1";

fn identity() -> serde_json::Value {
    serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "buildId": BUILD_ID,
        "helperVersion": env!("CARGO_PKG_VERSION"),
        "upstreamRevision": "337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17"
    })
}

/// The command socket is read before and after the separate Wayland connection.
/// No shell, hyprctl/grim substitution, focus dispatch, overlay or config writes.
fn capture_active(
    directory: &Path,
    excluded: &[u32],
    mut request: impl FnMut(&str) -> Result<String>,
    export: impl FnOnce(u64, &Path) -> Result<()>,
) -> Result<serde_json::Value> {
    ipc::ensure_unlocked(&request("j/locked")?)?;
    let window = ipc::active_window(&request("j/activewindow")?)?;
    if excluded.contains(&window.pid) {
        return Err("App Shot cannot capture its own application window.".into());
    }
    export(window.address()?, directory)?;
    // A successful export is not sufficient when the session became locked.
    // Remove only the image just created by our export, never a supplied path.
    let after = (|| -> Result<serde_json::Value> {
        ipc::ensure_unlocked(&request("j/locked")?)?;
        let windows = serde_json::from_str(&request("j/clients")?)?;
        Ok(serde_json::json!({ "window": captured_metadata(&window, windows) }))
    })();
    if after.is_err() {
        let _ = std::fs::remove_file(directory.join("capture.png"));
    }
    after
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // Version is independent of a running compositor and never connects to one.
    if args.len() == 2 && args[1] == "version" {
        return emit(identity());
    }
    ipc::session_directory()?;
    match args.get(1).map(String::as_str) {
        Some("check") if args.len() == 2 => {
            capture::check()?;
            let mut result = identity();
            result["captureAvailable"] = true.into();
            result["mappingVersion"] = 1.into();
            result["exportVersion"] = 2.into();
            result["feedbackAvailable"] = false.into();
            emit(result)
        }
        Some("capture") if args.len() == 4 => {
            let excluded = args[3]
                .split(',')
                .map(str::parse::<u32>)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if excluded.is_empty() || excluded.contains(&0) || excluded.len() > 256 {
                return Err("Invalid excluded capture process IDs.".into());
            }
            emit(capture_active(
                Path::new(&args[2]),
                &excluded,
                ipc::request,
                capture::capture,
            )?)
        }
        _ => Err("Expected version, check, or capture <private-directory> <excluded-pids>.".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::cell::RefCell;

    // Shaped like Hyprland's j/activewindow and j/clients replies, including fields we ignore.
    fn client(address: &str, title: &str, patch: Value) -> Value {
        let mut client = json!({
            "address": address, "mapped": true, "hidden": false,
            "at": [-1920, 20], "size": [1000, 800], "workspace": {"id": 2, "name": "2"},
            "floating": false, "monitor": 1, "class": "kitty", "title": title,
            "initialClass": "kitty", "initialTitle": "kitty", "pid": 4242, "xwayland": false,
        });
        client
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        client
    }

    fn parse<T: serde::de::DeserializeOwned>(reply: Value) -> T {
        serde_json::from_str(&reply.to_string()).unwrap()
    }

    fn metadata_after(before: Value, after: Vec<Value>) -> Option<Value> {
        captured_metadata(&parse(before), parse(Value::Array(after)))
    }

    #[test]
    fn keeps_captured_metadata_when_only_the_title_spinner_ticks() {
        for (before, after) in [("⠋ Document", "⠙ Document"), ("⠏ Document", "Document")] {
            let metadata = metadata_after(
                client("0xabc", before, json!({})),
                vec![
                    client("0xdef", "Other", json!({})),
                    client("0xabc", after, json!({})),
                ],
            )
            .unwrap_or_else(|| panic!("{before:?} -> {after:?} dropped metadata"));
            assert_eq!(metadata["title"], before);
            assert_eq!(metadata["processId"], 4242);
            assert_eq!(metadata["appName"], "kitty");
            assert_eq!(
                metadata["bounds"],
                json!({"x": -1920.0, "y": 20.0, "width": 1000.0, "height": 800.0})
            );
        }
    }

    #[test]
    fn drops_metadata_when_title_whitespace_changes() {
        for (before, after) in [
            ("Document", " Document "),
            ("Document", "Document "),
            (" Document", "Document"),
            ("⠋ Document", "⠙ Document "),
        ] {
            assert_eq!(
                metadata_after(
                    client("0xabc", before, json!({})),
                    vec![client("0xabc", after, json!({}))],
                ),
                None,
                "{before:?} -> {after:?}",
            );
        }
    }

    #[test]
    fn drops_metadata_when_the_window_identity_or_state_changed() {
        let before = || client("0xabc", "⠋ Document", json!({}));
        for after in [
            client("0xabc", "⠙ Other", json!({})),
            client("0xabc", "⠁ Document", json!({})),
            client("0xabc", "⠙Document", json!({})),
            client("0xabc", "⠙ Document", json!({"at": [-1900, 20]})),
            client("0xabc", "⠙ Document", json!({"size": [1000, 700]})),
            client("0xabc", "⠙ Document", json!({"pid": 99})),
            client("0xabc", "⠙ Document", json!({"class": "foot"})),
            client("0xabc", "⠙ Document", json!({"hidden": true})),
            client("0xabc", "⠙ Document", json!({"mapped": false})),
            client("0xdef", "⠋ Document", json!({})),
        ] {
            assert_eq!(
                metadata_after(before(), vec![after.clone()]),
                None,
                "{after}"
            );
        }
        assert_eq!(metadata_after(before(), vec![]), None);
    }
    #[test]
    fn capture_orders_lock_active_export_lock_identity() {
        let calls = RefCell::new(Vec::new());
        let directory = tempfile::tempdir().unwrap();
        let result = capture_active(
            directory.path(),
            &[999],
            |command| {
                calls.borrow_mut().push(command.to_owned());
                Ok(match command {
                    "j/locked" => json!({"locked":false}),
                    "j/activewindow" => client("0xabc", "Editor", json!({})),
                    "j/clients" => json!([client("0xabc", "Editor", json!({}))]),
                    _ => panic!("Unexpected command"),
                }
                .to_string())
            },
            |address, _| {
                assert_eq!(address, 0xabc);
                calls.borrow_mut().push("export".into());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *calls.borrow(),
            [
                "j/locked",
                "j/activewindow",
                "export",
                "j/locked",
                "j/clients"
            ]
        );
        assert_eq!(result["window"]["processId"], 4242);
    }

    #[test]
    fn lock_unknown_or_locked_fails_before_export() {
        for reply in [
            r#"{"locked":true}"#,
            "{}",
            "unavailable",
            r#"{"locked":"false"}"#,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let result = capture_active(
                directory.path(),
                &[999],
                |_| Ok(reply.into()),
                |_, _| panic!("Must not capture through lock or unknown lock state"),
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn own_window_fails_before_export() {
        let directory = tempfile::tempdir().unwrap();
        assert!(
            capture_active(
                directory.path(),
                &[4242],
                |command| Ok(if command == "j/locked" {
                    json!({"locked":false})
                } else {
                    client("0xabc", "ZenX", json!({}))
                }
                .to_string()),
                |_, _| panic!("Must not capture ZenX")
            )
            .is_err()
        );
    }

    #[test]
    fn post_capture_lock_failure_discards_file_and_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let mut locks = 0;
        let result = capture_active(
            directory.path(),
            &[999],
            |command| {
                Ok(match command {
                    "j/locked" => {
                        locks += 1;
                        json!({"locked":locks > 1})
                    }
                    "j/activewindow" => client("0xabc", "Editor", json!({})),
                    _ => panic!("No metadata query through lock"),
                }
                .to_string())
            },
            |_, path| {
                std::fs::write(path.join("capture.png"), b"synthetic")?;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!directory.path().join("capture.png").exists());
    }
}
