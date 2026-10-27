; Relo for Windows installer hooks (tauri.conf.json, bundle.windows.nsis.installerHooks).
;
; The installer is per user (installMode currentUser): no administrator prompt, nothing outside the user's profile. It
; registers the relo:// scheme (the deep-link plugin's schemes), adds the Start menu shortcut and carries the local-mode
; payload (the `server` resource folder) and the ReloServer.exe sidecar when the build supplies them
; (scripts/release/build-windows-app.mjs).
;
; Where the download came from (ReloReadInstallSource, after the files are in place): the browser marks a downloaded file
; with a Mark-of-the-Web, the Zone.Identifier stream of the installer, whose HostUrl= (and ReferrerUrl=) line names the page
; or file the download came from. When that is an https URL (http only on localhost or 127.0.0.1) whose path ends in
; /windows/relo-setup.exe or /relo-windows-setup.exe, Relo's own download names, its origin goes into
; %LOCALAPPDATA%\Relo\install-source.json as {"origin":"https://host[:port]"} and the Finish page's "Open Relo" starts the app
; with `--relo-origin <origin>`, so Relo opens already knowing which server to ask. Anything else (no mark, another site, a
; copy passed on by e-mail, a silent install by install.ps1) writes nothing and changes nothing. No server is named in this
; file: every Relo server hands out its own installer, and the origin is always read from the download.
;
; Install: Windows 10 version 1809 (build 17763) or later and 64-bit Windows are required (the Mac's "Relo for Mac needs
; a Mac with Apple silicon", RN/LocalServer.swift:213-218); the app says the same at launch (local/server.rs setup_problem).
;
; Uninstall (the Mac's "Uninstall Relo from this Mac", ReloLocalMode.swift:272-309, for the part a plain uninstall can do):
; before any file is removed, `ReloServer.exe stop` ends the local server gracefully (it drains the API and worker and stops
; PostgreSQL, up to 90 s), and `ReloServer.exe uninstall-login` removes the "Relo Server" logon task (and its Run fallback)
; so nothing starts a server from a folder that no longer exists. An update runs the old uninstaller with /UPDATE: the
; server is stopped so its files can be replaced, but the logon task stays (the new app starts the server again).
; The "Delete the application data" box on the uninstall page is off by default. Ticked, it also removes the local server's
; data (%LOCALAPPDATA%\Relo\server, which holds the database, secrets and logs, and local-mode.json), but only when the
; server really stopped: "Relo is still stopping, so its data was kept." The CLI's own files in %LOCALAPPDATA%\Relo (the
; `relo` launcher, Node) and its config in %APPDATA%\relo are the CLI's and stay. Removing the agents' instructions is the
; app's Settings -> Uninstall Relo from this PC, as on the Mac.

!include WinVer.nsh

Var ReloServerStopped
Var ReloOrigin

; The origin of a download URL that is Relo's own, or "". In and out: $R0. Uses $0-$5 and (through ReloOnly) $R1-$R6.
Function ReloOriginOf
  ; Trim the line ending the stream's lines carry.
  origin_trim:
    StrCpy $5 $R0 1 -1
    ${If} $5 == "$\r"
    ${OrIf} $5 == "$\n"
    ${OrIf} $5 == " "
      StrCpy $R0 $R0 -1
      Goto origin_trim
    ${EndIf}
  ; Drop a query or a fragment.
  ${StrLoc} $5 $R0 "?" ">"
  ${If} $5 != ""
    StrCpy $R0 $R0 $5
  ${EndIf}
  ${StrLoc} $5 $R0 "#" ">"
  ${If} $5 != ""
    StrCpy $R0 $R0 $5
  ${EndIf}
  ; The scheme: https anywhere, http only for a local server (checked with the host below).
  StrCpy $5 $R0 8
  ${If} $5 == "https://"
    StrCpy $0 "https://"
    StrCpy $1 $R0 "" 8
  ${Else}
    StrCpy $5 $R0 7
    ${If} $5 == "http://"
      StrCpy $0 "http://"
      StrCpy $1 $R0 "" 7
    ${Else}
      Goto origin_bad
    ${EndIf}
  ${EndIf}
  ; $2 is host[:port], $1 the path from its first slash.
  ${StrLoc} $5 $1 "/" ">"
  ${If} $5 = 0
    Goto origin_bad
  ${EndIf}
  StrCpy $2 $1 $5
  StrCpy $1 $1 "" $5
  ${StrCase} $1 $1 "L"
  StrCpy $5 $1 "" -23
  ${If} $5 != "/windows/relo-setup.exe"
  ${AndIf} $5 != "/relo-windows-setup.exe"
    Goto origin_bad
  ${EndIf}
  ${StrCase} $2 $2 "L"
  ${StrLoc} $5 $2 ":" ">"
  ${If} $5 == ""
    StrCpy $3 $2
  ${Else}
    ${If} $5 = 0
      Goto origin_bad
    ${EndIf}
    StrCpy $3 $2 $5
    IntOp $5 $5 + 1
    StrCpy $4 $2 "" $5
    StrLen $5 $4
    ${If} $5 = 0
    ${OrIf} $5 > 5
      Goto origin_bad
    ${EndIf}
    StrCpy $R1 $4
    StrCpy $R2 "0123456789"
    Call ReloOnly
    ${If} $R3 != 1
      Goto origin_bad
    ${EndIf}
  ${EndIf}
  ; The host: letters, digits, dots and dashes (no user name, no spaces, nothing that could leave the JSON or the command line).
  StrCpy $R1 $3
  StrCpy $R2 "abcdefghijklmnopqrstuvwxyz0123456789.-"
  Call ReloOnly
  ${If} $R3 != 1
    Goto origin_bad
  ${EndIf}
  ${If} $0 == "http://"
    ${If} $3 != "localhost"
    ${AndIf} $3 != "127.0.0.1"
      Goto origin_bad
    ${EndIf}
  ${EndIf}
  StrCpy $R0 "$0$2"
  Return
  origin_bad:
    StrCpy $R0 ""
FunctionEnd

; $R3 is 1 when $R1 is not empty and every character of it is in $R2, else 0. Uses $R4-$R6.
Function ReloOnly
  StrLen $R4 $R1
  ${If} $R4 = 0
    StrCpy $R3 0
    Return
  ${EndIf}
  StrCpy $R5 0
  ${While} $R5 < $R4
    StrCpy $R6 $R1 1 $R5
    ${StrLoc} $R6 $R2 $R6 ">"
    ${If} $R6 == ""
      StrCpy $R3 0
      Return
    ${EndIf}
    IntOp $R5 $R5 + 1
  ${EndWhile}
  StrCpy $R3 1
FunctionEnd

; The value after `key` (which starts with a line break, so a URL that happens to contain the words cannot pass for the
; line) up to the end of its line, from the text in $R0. In: $R0 text, $R1 key. Out: $R0 (empty when there is no such line).
Function ReloLineValue
  ${StrLoc} $0 $R0 $R1 ">"
  ${If} $0 == ""
    StrCpy $R0 ""
    Return
  ${EndIf}
  StrLen $1 $R1
  IntOp $0 $0 + $1
  StrCpy $R0 $R0 "" $0
  ${StrLoc} $0 $R0 "$\r" ">"
  ${If} $0 != ""
    StrCpy $R0 $R0 $0
  ${EndIf}
  ${StrLoc} $0 $R0 "$\n" ">"
  ${If} $0 != ""
    StrCpy $R0 $R0 $0
  ${EndIf}
FunctionEnd

; Reads the installer's Mark-of-the-Web (its Zone.Identifier stream; the first 1000 bytes are plenty), sets $ReloOrigin and
; writes install-source.json when it names a Relo server. The stream is opened with CreateFile: NSIS's own FileOpen cannot.
Function ReloReadInstallSource
  StrCpy $ReloOrigin ""
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ; GENERIC_READ, shared with everyone, OPEN_EXISTING. The handle is -1 when the installer has no mark.
  System::Call 'kernel32::CreateFileW(w "$EXEPATH:Zone.Identifier", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p .r1'
  ${If} $1 <> -1
    System::Alloc 1024
    Pop $2
    System::Call 'kernel32::ReadFile(p r1, p r2, i 1000, *i .r3, p 0) i .r4'
    System::Call 'kernel32::CloseHandle(p r1)'
    System::Call '*$2(&m1023 .r5)'
    System::Free $2
    ; HostUrl (where the file itself came from) first, then ReferrerUrl (the page that linked to it).
    StrCpy $R0 $5
    StrCpy $R1 "$\nHostUrl="
    Call ReloLineValue
    Call ReloOriginOf
    ${If} $R0 == ""
      StrCpy $R0 $5
      StrCpy $R1 "$\nReferrerUrl="
      Call ReloLineValue
      Call ReloOriginOf
    ${EndIf}
    StrCpy $ReloOrigin $R0
  ${EndIf}
  ${If} $ReloOrigin != ""
    CreateDirectory "$LOCALAPPDATA\Relo"
    ClearErrors
    FileOpen $R9 "$LOCALAPPDATA\Relo\install-source.json" w
    ${IfNot} ${Errors}
      FileWrite $R9 '{"origin":"$ReloOrigin"}'
      FileClose $R9
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
; Stops the local server if this folder carries ReloServer.exe. Sets $ReloServerStopped to 1 when nothing is left running.
!macro ReloStopServer
  StrCpy $ReloServerStopped 1
  ${If} ${FileExists} "$INSTDIR\ReloServer.exe"
    ExecWait '"$INSTDIR\ReloServer.exe" stop --root "$LOCALAPPDATA\Relo\server"' $0
    ${If} $0 <> 0
      StrCpy $ReloServerStopped 0
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastBuild} 17763
    MessageBox MB_OK|MB_ICONSTOP "Relo for Windows needs Windows 10 version 1809 or later, or Windows 11." /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Relo for Windows needs a 64-bit PC." /SD IDOK
    Abort
  ${EndIf}
  ; The default folder would be %LOCALAPPDATA%\Relo, which is where the CLI's launcher, Node and CLI live
  ; (install.ps1). The app goes beside, not among them. An earlier install's folder or /D= is left as it is.
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
  ${EndIf}
  ; Installing over a running copy (an earlier installer had no uninstall hook): its server holds files open.
  !insertmacro ReloStopServer
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Call ReloReadInstallSource
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ReloStopServer
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "$INSTDIR\ReloServer.exe"
      ExecWait '"$INSTDIR\ReloServer.exe" uninstall-login'
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ${If} $ReloServerStopped = 1
      RMDir /r "$LOCALAPPDATA\Relo\server"
      Delete "$LOCALAPPDATA\Relo\local-mode.json"
      Delete "$LOCALAPPDATA\Relo\install-source.json"
      ; Only when nothing else (the CLI's launcher and Node) is in it.
      RMDir "$LOCALAPPDATA\Relo"
    ${Else}
      MessageBox MB_OK|MB_ICONINFORMATION "Relo is still stopping, so its data was kept. Delete the Relo folder in your Local AppData once Relo has quit." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
