use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite() && n.abs() < 100_000.0)
            && self.width > 0.0
            && self.height > 0.0
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Window {
    pub address: String,
    pub pid: u32,
    pub title: String,
    pub class: String,
    pub at: [i32; 2],
    pub size: [i32; 2],
    pub mapped: bool,
    pub hidden: bool,
}
impl Window {
    pub fn address(&self) -> Result<u64> {
        let address = self
            .address
            .strip_prefix("0x")
            .ok_or("Invalid Hyprland window address")?;
        Ok(u64::from_str_radix(address, 16)?)
    }
    pub fn bounds(&self) -> Rect {
        Rect {
            x: self.at[0].into(),
            y: self.at[1].into(),
            width: self.size[0].into(),
            height: self.size[1].into(),
        }
    }
    pub fn metadata(&self) -> serde_json::Value {
        serde_json::json!({"title": self.title, "appName": self.class, "appIdentifier": self.class,
            "processId": self.pid, "bounds": self.bounds(), "clientBounds": self.bounds()})
    }
    /// Same window, geometry and state; only a CLI title spinner may differ.
    pub fn matches_after_capture(&self, current: &Self) -> bool {
        self.address == current.address
            && self.pid == current.pid
            && self.class == current.class
            && self.at == current.at
            && self.size == current.size
            && self.mapped == current.mapped
            && self.hidden == current.hidden
            && capture_title(&self.title) == capture_title(&current.title)
    }
}

/// Match the same leading CLI spinner accepted by the Wayland AT-SPI window matcher.
fn capture_title(title: &str) -> &str {
    let mut chars = title.chars();
    if matches!(
        chars.next(),
        Some('⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏')
    ) && chars.clone().next().is_some_and(char::is_whitespace)
    {
        let label = chars.as_str().trim_start();
        if !label.is_empty() {
            return label;
        }
    }
    title
}

pub fn session_directory() -> Result<PathBuf> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    if !desktop
        .split(':')
        .any(|name| name.eq_ignore_ascii_case("hyprland"))
        || std::env::var_os("FLATPAK_ID").is_some()
        || std::env::var_os("SNAP").is_some()
        || std::env::var_os("SNAP_NAME").is_some()
    {
        return Err("Window capture requires a native Hyprland session.".into());
    }
    let runtime = PathBuf::from(std::env::var("XDG_RUNTIME_DIR")?);
    let instance = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")?;
    if !runtime.is_absolute()
        || instance.is_empty()
        || !instance
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid Hyprland session environment.".into());
    }
    Ok(runtime.join("hypr").join(instance))
}

pub fn request(command: &str) -> Result<String> {
    let mut socket = UnixStream::connect(session_directory()?.join(".socket.sock"))?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    socket.write_all(command.as_bytes())?;
    let mut reply = String::new();
    socket
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut reply)?;
    if reply.len() > 4 * 1024 * 1024 {
        return Err("Oversized Hyprland reply.".into());
    }
    Ok(reply)
}

pub fn ensure_unlocked(reply: &str) -> Result<()> {
    // Fail closed on unsupported/unknown replies too; never capture through a lock screen.
    #[derive(Deserialize)]
    struct LockState {
        locked: bool,
    }
    if serde_json::from_str::<LockState>(reply)?.locked {
        return Err("Unlock your Hyprland session before capturing a window.".into());
    }
    Ok(())
}

pub fn active_window(reply: &str) -> Result<Window> {
    let window: Window =
        serde_json::from_str(reply).map_err(|_| "Hyprland has no active window to capture.")?;
    if !window.mapped || window.hidden || !window.bounds().valid() || window.pid == 0 {
        return Err("Hyprland has no visible active window to capture.".into());
    }
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_preserves_upper_bits() {
        let window: Window = serde_json::from_str(r#"{"address":"0x123456789abcdef","pid":123,"title":"Editor","class":"editor","at":[-1920,20],"size":[1000,800],"mapped":true,"hidden":false}"#).unwrap();
        assert_eq!(window.address().unwrap(), 0x123456789abcdef);
        assert!(window.bounds().valid());
    }

    #[test]
    fn rectangles_reject_invalid_sizes() {
        assert!(
            !Rect {
                x: 0.,
                y: 0.,
                width: f64::NAN,
                height: 10.
            }
            .valid()
        );
        assert!(
            !Rect {
                x: 0.,
                y: 0.,
                width: 0.,
                height: 10.
            }
            .valid()
        );
    }
}
