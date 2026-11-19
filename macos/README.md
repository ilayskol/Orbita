# macOS build inputs

Native arm64 and x64 packages use the same offline UI as Orbita 1.8.8 for Windows/Linux. `ui.sha256` locks the exact bundled HTML, including its CSP hashes. `.gitattributes` prevents line-ending conversion. Runtime files are shared with the desktop source; macOS adds native Edit menu roles and a DMG.

Run the **macOS packages** workflow manually. Each architecture runs backend tests, builds DMG/ZIP, verifies signatures/ASAR/fuses/architecture, boots the hardened application, and exercises the packaged ASAR using a developer Electron shell. QA uses synthetic records and an isolated profile. The hardened release binary keeps CLI inspection disabled.

These builds are ad-hoc signed, not notarized or Developer ID signed. Do not claim Gatekeeper acceptance from CI boot tests. User installation instructions are in `assets/Инструкция-mac.txt`. No user profiles or customer exports belong in this directory.

`got` is pinned through an override because the previous lock referenced an unavailable download. It is used by build tools, not the offline application.
