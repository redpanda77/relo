//! Global shortcuts (tauri-plugin-global-shortcut). The Mac's two defaults, with Cmd mapped to Ctrl:
//! "Toggle Sneak Peek" Cmd-Shift-H -> Ctrl+Shift+H and "Toggle Notch Open" Cmd-Shift-I -> Ctrl+Shift+I
//! (boringNotchApp.swift:490-546, ShortcutConstants.swift). A press emits `shortcut` {action} to the notch window.
//!
//! Conflicts: two actions never share a binding (the second is refused), and a binding another app already owns
//! fails to register; the failure stays on the binding (`registered: false`, `error`) so Settings can show it, and
//! `shortcuts_changed` broadcasts the full list after every change.
//!
//! Persistence belongs to Settings: it stores `{ "shortcuts": { "<action>": "<accelerator>" } }` in settings.json
//! and calls `shortcuts_apply` on change; at startup the same key is read here.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// (action, label as on the Mac, default accelerator)
pub const ACTIONS: [(&str, &str, &str); 2] = [
    ("toggleSneakPeek", "Toggle Sneak Peek", "Ctrl+Shift+H"),
    ("toggleNotchOpen", "Toggle Notch Open", "Ctrl+Shift+I"),
];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutInfo {
    pub action: String,
    pub label: String,
    /// Normalised, e.g. "Ctrl+Shift+H". Empty = unbound.
    pub accelerator: String,
    pub default_accelerator: String,
    pub registered: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
struct ShortcutEvent {
    action: String,
}

static STATE: Mutex<Vec<ShortcutInfo>> = Mutex::new(Vec::new());

// ---- Pure part (tested) ----

fn canonical_token(t: &str) -> String {
    match t.trim().to_ascii_lowercase().as_str() {
        "control" | "ctrl" | "commandorcontrol" | "cmdorctrl" | "commandorctrl" => "Ctrl".into(),
        "alt" | "option" => "Alt".into(),
        "shift" => "Shift".into(),
        "super" | "cmd" | "command" | "win" | "meta" | "windows" => "Super".into(),
        other => {
            // A key: single letters upper-case, "f5" -> "F5", names capitalised.
            let mut c = other.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + c.as_str(),
                None => String::new(),
            }
        }
    }
}

/// "ctrl + shift + h" -> "Ctrl+Shift+H". Modifiers in a fixed order, one key last. Needs at least one modifier
/// (a bare key would steal typing from every app) and exactly one key.
pub fn normalize(accelerator: &str) -> Result<String, String> {
    let mut mods: Vec<String> = Vec::new();
    let mut key: Option<String> = None;
    for raw in accelerator.split('+') {
        let t = canonical_token(raw);
        if t.is_empty() {
            return Err("The shortcut is incomplete.".into());
        }
        if matches!(t.as_str(), "Ctrl" | "Alt" | "Shift" | "Super") {
            if !mods.contains(&t) {
                mods.push(t);
            }
        } else if key.replace(t).is_some() {
            return Err("A shortcut has one key besides its modifiers.".into());
        }
    }
    let key = key.ok_or("Press a key together with Ctrl, Alt, Shift or Win.")?;
    if mods.is_empty() {
        return Err("Add Ctrl, Alt, Shift or Win: a bare key would steal typing from every app.".into());
    }
    mods.sort_by_key(|m| ["Ctrl", "Alt", "Shift", "Super"].iter().position(|x| x == m));
    mods.push(key);
    let out = mods.join("+");
    Shortcut::from_str(&out).map_err(|_| format!("{out} is not a key combination Windows accepts."))?;
    Ok(out)
}

/// The label of another action already bound to `accelerator`.
pub fn conflict<'a>(list: &'a [ShortcutInfo], action: &str, accelerator: &str) -> Option<&'a str> {
    list.iter().find(|s| s.action != action && !s.accelerator.is_empty() && s.accelerator == accelerator).map(|s| s.label.as_str())
}

pub fn defaults() -> Vec<ShortcutInfo> {
    ACTIONS
        .iter()
        .map(|(a, l, d)| ShortcutInfo {
            action: a.to_string(),
            label: l.to_string(),
            accelerator: d.to_string(),
            default_accelerator: d.to_string(),
            registered: false,
            error: None,
        })
        .collect()
}

/// Defaults overlaid with a saved `{action: accelerator}` map. Unknown actions and invalid or duplicate
/// accelerators are ignored (the default stays), an empty string unbinds.
pub fn overlay(saved: &HashMap<String, String>) -> Vec<ShortcutInfo> {
    let mut list = defaults();
    for i in 0..list.len() {
        let Some(want) = saved.get(&list[i].action) else { continue };
        if want.trim().is_empty() {
            list[i].accelerator.clear();
        } else if let Ok(n) = normalize(want) {
            if conflict(&list, &list[i].action.clone(), &n).is_none() {
                list[i].accelerator = n;
            }
        }
    }
    list
}

pub fn saved_map(settings: &Value) -> HashMap<String, String> {
    settings
        .get("shortcuts")
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default()
}

// ---- Registration ----

fn register(app: &AppHandle, action: &str, accelerator: &str) -> Result<(), String> {
    let sc = Shortcut::from_str(accelerator).map_err(|e| e.to_string())?;
    let action = action.to_string();
    app.global_shortcut()
        .on_shortcut(sc, move |app, _sc, ev| {
            if ev.state == ShortcutState::Pressed {
                let _ = app.emit_to("notch", "shortcut", ShortcutEvent { action: action.clone() });
            }
        })
        .map_err(|_| format!("{accelerator} is already used by another app."))
}

fn unregister(app: &AppHandle, accelerator: &str) {
    if let Ok(sc) = Shortcut::from_str(accelerator) {
        let _ = app.global_shortcut().unregister(sc);
    }
}

fn broadcast(app: &AppHandle, list: &[ShortcutInfo]) {
    let _ = app.emit("shortcuts_changed", list);
}

/// Register every binding of `list`, recording failures on it.
fn register_all(app: &AppHandle, list: &mut [ShortcutInfo]) {
    for s in list.iter_mut() {
        if s.accelerator.is_empty() {
            s.registered = false;
            s.error = None;
            continue;
        }
        match register(app, &s.action, &s.accelerator) {
            Ok(()) => {
                s.registered = true;
                s.error = None;
            }
            Err(e) => {
                s.registered = false;
                s.error = Some(e);
            }
        }
    }
}

/// Call once from setup, after the plugin is installed.
pub fn init(app: &AppHandle) {
    let settings = crate::settings_window::settings_read().unwrap_or(Value::Null);
    let mut list = overlay(&saved_map(&settings));
    register_all(app, &mut list);
    for s in &list {
        if let Some(e) = &s.error {
            eprintln!("relo: shortcut {} not registered: {e}", s.action);
        }
    }
    *STATE.lock().unwrap() = list;
}

#[tauri::command]
pub fn shortcuts_list() -> Vec<ShortcutInfo> {
    STATE.lock().unwrap().clone()
}

/// Rebind one action. `accelerator` empty or null unbinds. Errors leave the previous binding in place.
#[tauri::command]
pub fn shortcuts_set(app: AppHandle, action: String, accelerator: Option<String>) -> Result<Vec<ShortcutInfo>, String> {
    let mut list = STATE.lock().unwrap();
    let i = list.iter().position(|s| s.action == action).ok_or_else(|| format!("unknown shortcut: {action}"))?;
    let want = accelerator.unwrap_or_default();
    let new = if want.trim().is_empty() { String::new() } else { normalize(&want)? };
    if !new.is_empty() {
        if let Some(other) = conflict(&list, &action, &new) {
            return Err(format!("{new} is already used for \"{other}\"."));
        }
    }
    let old = list[i].accelerator.clone();
    if old == new && list[i].registered == !new.is_empty() {
        return Ok(list.clone());
    }
    if list[i].registered {
        unregister(&app, &old);
    }
    if new.is_empty() {
        list[i] = ShortcutInfo { accelerator: String::new(), registered: false, error: None, ..list[i].clone() };
    } else if let Err(e) = register(&app, &action, &new) {
        // Put the old binding back, so a refused rebind never leaves the action dead.
        if list[i].registered && !old.is_empty() {
            let _ = register(&app, &action, &old);
        }
        return Err(e);
    } else {
        list[i] = ShortcutInfo { accelerator: new, registered: true, error: None, ..list[i].clone() };
    }
    let out = list.clone();
    drop(list);
    broadcast(&app, &out);
    Ok(out)
}

/// Replace every binding from a saved `{action: accelerator}` map (Settings calls this when it loads or resets).
#[tauri::command]
pub fn shortcuts_apply(app: AppHandle, bindings: HashMap<String, String>) -> Vec<ShortcutInfo> {
    let mut list = STATE.lock().unwrap();
    for s in list.iter().filter(|s| s.registered) {
        unregister(&app, &s.accelerator);
    }
    let mut next = overlay(&bindings);
    register_all(&app, &mut next);
    *list = next.clone();
    drop(list);
    broadcast(&app, &next);
    next
}

/// Settings changed the saved bindings: re-registers only when they mean something other than what is registered now.
pub fn sync(app: &AppHandle, saved: &HashMap<String, String>) {
    let want: Vec<String> = overlay(saved).into_iter().map(|s| s.accelerator).collect();
    let have: Vec<String> = STATE.lock().unwrap().iter().map(|s| s.accelerator.clone()).collect();
    if want != have {
        shortcuts_apply(app.clone(), saved.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalises_accelerators() {
        assert_eq!(normalize("ctrl+shift+h").unwrap(), "Ctrl+Shift+H");
        assert_eq!(normalize("Shift + Control + I").unwrap(), "Ctrl+Shift+I");
        assert_eq!(normalize("cmd+shift+k").unwrap(), "Shift+Super+K");
        assert_eq!(normalize("Alt+F5").unwrap(), "Alt+F5");
        assert_eq!(normalize("ctrl+ctrl+h").unwrap(), "Ctrl+H");
    }

    #[test]
    fn rejects_incomplete_or_dangerous_ones() {
        assert!(normalize("").is_err());
        assert!(normalize("h").is_err());
        assert!(normalize("Ctrl+Shift").is_err());
        assert!(normalize("Ctrl+A+B").is_err());
        assert!(normalize("Ctrl++").is_err());
        assert!(normalize("Ctrl+Nonsense").is_err());
    }

    #[test]
    fn defaults_are_the_macs_with_ctrl() {
        let d = defaults();
        assert_eq!(d[0].action, "toggleSneakPeek");
        assert_eq!(d[0].accelerator, "Ctrl+Shift+H");
        assert_eq!(d[1].accelerator, "Ctrl+Shift+I");
        for s in &d {
            assert_eq!(normalize(&s.accelerator).unwrap(), s.accelerator);
        }
    }

    #[test]
    fn conflicts_name_the_other_action() {
        let d = defaults();
        assert_eq!(conflict(&d, "toggleSneakPeek", "Ctrl+Shift+I"), Some("Toggle Notch Open"));
        assert_eq!(conflict(&d, "toggleNotchOpen", "Ctrl+Shift+I"), None);
        assert_eq!(conflict(&d, "toggleNotchOpen", "Ctrl+Alt+Q"), None);
    }

    #[test]
    fn saved_bindings_overlay_the_defaults() {
        let saved = saved_map(&json!({"shortcuts": {"toggleSneakPeek": "alt+shift+p", "toggleNotchOpen": "", "bogus": "ctrl+x"}}));
        let l = overlay(&saved);
        assert_eq!(l[0].accelerator, "Alt+Shift+P");
        assert_eq!(l[1].accelerator, "");
        // A saved duplicate or invalid value falls back to the default.
        let dup = saved_map(&json!({"shortcuts": {"toggleSneakPeek": "ctrl+shift+i", "toggleNotchOpen": "nope"}}));
        let l = overlay(&dup);
        assert_eq!(l[0].accelerator, "Ctrl+Shift+H");
        assert_eq!(l[1].accelerator, "Ctrl+Shift+I");
        assert!(saved_map(&json!({})).is_empty());
    }
}
