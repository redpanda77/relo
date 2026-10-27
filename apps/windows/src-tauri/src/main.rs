// Relo for Windows: the notch shell. The pointer-polling click-through idea follows codenotch
// (MIT, https://github.com/vinzdg/codenotch; see apps/windows/THIRD_PARTY.md), rewritten here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth_window;
mod chrome;
mod cli_setup;
mod autostart;
mod displays;
mod fullscreen;
mod geometry;
mod gestures;
mod glass;
mod home_window;
mod launch;
mod media;
mod mirrors;
mod profile;
mod quit;
mod local;
mod os;
mod secrets;
mod settings_window;
mod services;
mod session;
mod shelf;
mod shortcuts;
mod system;
mod tray;
mod voice;
mod updater;
#[cfg(windows)]
mod win;

use displays::place;
use geometry::{next_inside, poll_interval_ms, Rect};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

#[tauri::command]
fn fullscreen_get() -> bool {
    #[cfg(windows)]
    return fullscreen::current();
    #[cfg(not(windows))]
    false
}

/// The page asks for the keyboard while a text field is being edited, and gives it back afterwards.
#[tauri::command]
fn notch_keyboard(app: AppHandle, on: bool) {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("notch") {
        win::set_keyboard(&w, on);
    }
    #[cfg(not(windows))]
    let _ = (app, on);
}

/// Hot rect reported by the page (physical px, window-relative). None = click-through everywhere:
/// losing one click beats eating all clicks.
static HOT: Mutex<Option<Rect>> = Mutex::new(None);

#[tauri::command]
fn set_hot(window: tauri::Window, rect: Rect) {
    // MIRRORS: a mirror notch (one per extra display, mirrors.rs) keeps its own hot rect.
    if mirrors::is_mirror(window.label()) {
        mirrors::set_hot(window.label(), rect);
        return;
    }
    shelf::note_hot(rect);
    *HOT.lock().unwrap() = Some(rect);
}

/// Poll the cursor (16 ms over the window, 100 ms elsewhere), toggle click-through only on change and
/// tell the page, which gets no mouse events while click-through.
fn start_pointer_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut inside = false;
        let mut applied: Option<bool> = None; // click-through currently applied
        loop {
            let Some(w) = app.get_webview_window("notch") else {
                std::thread::sleep(Duration::from_millis(250));
                continue;
            };
            let (Ok(pos), Ok(cur), Ok(sz)) = (w.outer_position(), app.cursor_position(), w.outer_size()) else {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            };
            let scale = w.scale_factor().unwrap_or(1.0);
            let (lx, ly) = (cur.x - pos.x as f64, cur.y - pos.y as f64);
            let win = (sz.width as f64, sz.height as f64);
            let in_window = lx >= 0.0 && ly >= 0.0 && lx < win.0 && ly < win.1;
            let hot = *HOT.lock().unwrap();
            // A file being dragged over the notch counts as hovering it (opens it); an incoming drag also
            // needs the window to take mouse input, which OLE requires (see shelf/mod.rs).
            let now = next_inside(hot, inside, lx, ly, win, scale) || shelf::keep_open();
            let takes_input = now || shelf::capturing();
            if applied != Some(!takes_input) {
                let _ = w.set_ignore_cursor_events(!takes_input);
                applied = Some(!takes_input);
            }
            if now != inside {
                inside = now;
                let _ = app.emit_to("notch", "notch_pointer", inside);
            }
            // Click and wheel detection (gestures.rs) rides this tick: it only needs "pointer over the notch".
            gestures::on_poll(&app, inside);
            std::thread::sleep(Duration::from_millis(poll_interval_ms(in_window || shelf::capturing())));
        }
    });
}

fn main() {
    os::mark_process_start();
    tauri::Builder::default()
        // First, so a second launch (or a relo:// link) is forwarded to the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("relo: second instance launched ({} args)", argv.len());
            os::handle_second_instance(app, &argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        // The page cannot call a Relo server directly (it sends no CORS headers): HTTP goes through Rust,
        // see src/client/transport.ts and the scope in capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_hot,
            notch_keyboard,
            displays::list_displays,
            displays::set_display,
            tray::set_tray,
            os::open_url,
            auth_window::open_sign_in_window,
            auth_window::close_sign_in_window,
            services::show_toast,
            services::log_event,
            updater::updater_configure,
            updater::updater_check_now,
            updater::updater_check_manual,
            updater::updater_enabled,
            updater::updater_install,
            updater::updater_after_update,
            os::launch_args,
            os::install_source,
            cli_setup::cli_prepare,
            cli_setup::cli_join,
            os::restart_relo,
            os::open_task_scheduler,
            os::launch_mark,
            glass::glass_active,
            chrome::chrome_ready,
            chrome::chrome_state_get,
            chrome::chrome_minimize,
            chrome::chrome_toggle_maximize,
            chrome::chrome_close,
            chrome::chrome_snap_rect,
            os::secret_get,
            os::secret_set,
            os::secret_delete,
            os::autostart_get,
            os::autostart_set,
            fullscreen_get,
            settings_window::open_settings,
            settings_window::settings_read,
            settings_window::settings_write,
            settings_window::settings_page_take,
            settings_window::open_logs_folder,
            settings_window::detect_agents,
            settings_window::run_setup_agent,
            settings_window::quit_relo,
            quit::quit_ready,
            settings_window::hide_settings,
            settings_window::set_tray_visible,
            settings_window::owner_state_get,
            settings_window::computer_name,
            voice::voice_status,
            voice::voice_start,
            voice::voice_download,
            voice::voice_download_cancel,
            voice::voice_delete,
            voice::voice_speak,
            voice::voice_cancel,
            voice::voice_preview,
            voice::voice_set_engine,
            voice::voice_microphone_in_use,
            media::media_get,
            media::media_control,
            media::media_seek,
            media::media_volume,
            media::media_visualizer,
            media::media_lyrics,
            media::media_open_app,
            media::media_foreground_is_source,
            media::media_settings_read,
            media::media_settings_write,
            shelf::shelf_snapshot,
            shelf::shelf_settings_set,
            shelf::shelf_add_paths,
            shelf::shelf_add_text,
            shelf::shelf_remove,
            shelf::shelf_cleanup,
            shelf::shelf_rename,
            shelf::shelf_set_share_rect,
            shelf::shelf_open,
            shelf::shelf_reveal,
            shelf::shelf_open_with,
            shelf::shelf_quick_look,
            shelf::shelf_copy_path,
            shelf::shelf_copy,
            shelf::shelf_thumbnail,
            shelf::shelf_drag_out,
            shelf::shelf_share,
            shelf::shelf_pick_and_share,
            shelf::shelf_context_menu,
            local::local_state_get,
            local::local_check,
            local::local_start,
            local::local_detect_agents,
            local::local_install_command,
            local::local_link,
            local::local_commit,
            local::local_test_card,
            local::local_repair,
            local::local_set_up_agents,
            local::local_leave,
            local::local_abandon,
            local::local_uninstall,
            local::local_remote_host,
            local::local_show_logs,
            home_window::open_home,
            home_window::close_home,
            home_window::home_publish,
            home_window::home_state_get,
            home_window::home_open_notch,
            home_window::home_open_dashboard,
            system::system_sample,
            system::system_stop,
            shortcuts::shortcuts_list,
            shortcuts::shortcuts_set,
            shortcuts::shortcuts_apply,
            gestures::gestures_configure
        ])
        .setup(|app| {
            let h = app.handle().clone();
            // A debug build must run under the dev identifier (its own WebView data), or it shares the installed app's.
            let configured = h.config().identifier.clone();
            if profile::DEV && !profile::identifier_matches(&configured, true) && std::env::var_os("RELO_ALLOW_SHARED_IDENTIFIER").is_none() {
                eprintln!(
                    "relo: this build runs as {configured} but must run as {}. Start it with `pnpm dev:app` (it merges src-tauri/tauri.dev.conf.json); set RELO_ALLOW_SHARED_IDENTIFIER=1 to run anyway.",
                    profile::identifier_for(profile::DEV)
                );
                std::process::exit(2);
            }
            // The taskbar, Alt-Tab and notifications show Relo's name and icon only when the process carries the same
            // AppUserModelID the installer stamps on the Start menu shortcut (installer.nsi SetLnkAppUserModelId: the
            // bundle identifier). Without it Windows groups the windows under the bare exe.
            #[cfg(windows)]
            os::set_app_user_model_id(&configured);
            // The Run entry of an earlier build lacks `--at-login`: add it.
            if let Ok(exe) = std::env::current_exe() {
                #[cfg(windows)]
                let _ = autostart::migrate(&autostart::RegistryRunKey, &exe.to_string_lossy());
                #[cfg(not(windows))]
                let _ = exe;
            }
            voice::init(&h);

            // Sign-in arrives as relo://auth/callback; os::handle_url validates strictly and emits auth_callback.
            // The installer registers the scheme; at dev time registering writes HKCU, so it is opt-in.
            let dl = h.clone();
            app.deep_link().on_open_url(move |ev| {
                for url in ev.urls() {
                    os::handle_url(&dl, url.as_str());
                }
            });
            os::handle_args(&h, &std::env::args().collect::<Vec<_>>());
            if std::env::var_os("RELO_REGISTER_DEEP_LINK").is_some() {
                let _ = app.deep_link().register_all();
            }

            let w = h.get_webview_window("notch").expect("notch window");
            #[cfg(windows)]
            win::stamp_style(&w);
            mirrors::start(h.clone()); // MIRRORS: worker + pointer loop for the extra displays
            place(&h);
            // Order: place, click-through on, then show. A hidden WebView2 stops painting, so never hide it.
            let _ = w.set_ignore_cursor_events(true);
            let _ = w.show();
            os::log_launch("windowShown");
            #[cfg(windows)]
            win::start_topmost_watchdog(h.clone());
            #[cfg(windows)]
            session::start(h.clone());
            glass::init(&h);
            tray::init(&h)?;
            local::init(&h);
            settings_window::init(&h);
            media::start(&h);
            shelf::init(&h);
            home_window::init(&h);
            shortcuts::init(&h);
            gestures::start();
            #[cfg(windows)]
            fullscreen::start(h.clone());
            start_pointer_loop(h.clone());
            displays::start(h);
            Ok(())
        })
        // The notch page finished loading: its first draw follows at once (Mac: "launch: first notch draw after N ms").
        .on_page_load(|webview, payload| {
            if webview.label() == "notch" && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                os::log_launch("firstDraw");
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                place(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Relo tauri application");
}
