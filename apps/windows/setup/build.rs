// Embeds the installer this program runs (RELO_SETUP_PAYLOAD: the NSIS setup that scripts/release/build-windows-app.mjs built),
// and gives the program Relo's icon, version info and a manifest.
//
// The manifest matters: Windows guesses that a program named "setup" or "install" needs administrator rights unless its
// manifest says asInvoker, and Relo's install is per user and must never show a UAC prompt.
use std::{env, fs, path::PathBuf};

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;

fn main() {
    println!("cargo:rerun-if-env-changed=RELO_SETUP_PAYLOAD");
    println!("cargo:rerun-if-env-changed=RELO_SETUP_VERSION");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("payload.bin");
    match env::var("RELO_SETUP_PAYLOAD") {
        Ok(path) if !path.trim().is_empty() => {
            println!("cargo:rerun-if-changed={path}");
            fs::copy(&path, &out).unwrap_or_else(|e| panic!("cannot read the installer {path}: {e}"));
        }
        // A build without an installer (development, tests): the program says so instead of running anything.
        _ => fs::write(&out, []).unwrap(),
    }

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let version = env::var("RELO_SETUP_VERSION").unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap());
        let mut parts = version.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        let (major, minor, patch) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
        let numeric = (major << 48) | (minor << 32) | (patch << 16);
        let mut res = tauri_winres::WindowsResource::new();
        res.set_icon("../src-tauri/icons/icon.ico");
        res.set_manifest(MANIFEST);
        res.set_version_info(tauri_winres::VersionInfo::FILEVERSION, numeric);
        res.set_version_info(tauri_winres::VersionInfo::PRODUCTVERSION, numeric);
        res.set("CompanyName", "Relo");
        res.set("FileDescription", "Relo Setup");
        res.set("ProductName", "Relo");
        res.set("FileVersion", &version);
        res.set("ProductVersion", &version);
        res.set("LegalCopyright", "Copyright (c) 2026 Relo");
        res.set("OriginalFilename", "relo-windows-setup.exe");
        res.compile().expect("could not embed the icon and version info (needs the Windows SDK's rc.exe)");
    }
}
