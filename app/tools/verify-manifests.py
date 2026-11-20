#!/usr/bin/env python3
"""Check merged flavor manifests after Gradle builds; source overlays alone do not prove packaging."""
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

BUILD = pathlib.Path(__file__).resolve().parents[1] / "android/app/build"
ANDROID = "{http://schemas.android.com/apk/res/android}"
variant = sys.argv[1] if len(sys.argv) == 2 else "debug"
if variant not in ("debug", "release") or len(sys.argv) > 2:
    raise SystemExit("usage: python3 app/tools/verify-manifests.py [debug|release]")

# Prevent a permission/browser package leaking back into shared code while manifests stay clean.
source = BUILD.parent / "src"
for area in ("main", "androidXr"):
    for path in (source / area).rglob("*.kt"):
        text = path.read_text()
        assert not re.search(r'"(?:com\.oculus\.|com\.meta\.)', text), path
        # Meta's Platform SDK is a questImplementation dependency; shared code reaches it only through HeadsetSignIn.
        assert not re.search(r'^import (?:com\.oculus|com\.meta|horizon)\.', text, re.M), path

versions = []
for flavor in ("quest", "androidXr"):
    name = flavor + variant.capitalize()
    task = "process" + name[0].upper() + name[1:] + "Manifest"
    path = BUILD / "intermediates/merged_manifests" / name / task / "AndroidManifest.xml"
    root = ET.parse(path).getroot()
    metadata = json.loads((BUILD / "outputs/apk" / flavor / variant / "output-metadata.json").read_text())
    assert metadata["applicationId"] == "net.polydance.capture"
    assert metadata["variantName"] == name
    artifact = metadata["elements"][0]
    assert artifact["outputFile"] == f"app-{flavor}-{variant}.apk"
    assert root.get(ANDROID + "versionName") == artifact["versionName"]
    versions.append((artifact["versionCode"], artifact["versionName"]))
    assert root.get("package") == "net.polydance.capture", path
    permissions = {p.get(ANDROID + "name") for p in root.findall("uses-permission")}
    assert {
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
        "android.permission.FOREGROUND_SERVICE_MICROPHONE",
        "android.permission.RECORD_AUDIO",
    } <= permissions, path
    # Logs in a take (docs/LOGS.md): READ_LOGS only where adb can grant it. Meta prohibits it, as it does
    # PACKAGE_USAGE_STATS, so a release build must not declare either.
    assert ("android.permission.READ_LOGS" in permissions) == (variant == "debug"), (path, "READ_LOGS")
    assert ("android.permission.PACKAGE_USAGE_STATS" in permissions) == (variant == "debug"), (path, "PACKAGE_USAGE_STATS")
    app = root.find("application")
    assert app is not None
    assert app.get(ANDROID + "allowBackup") == "false"
    assert app.get(ANDROID + "usesCleartextTraffic") == str(variant == "debug").lower()
    activities = {a.get(ANDROID + "name"): a for a in app.findall("activity")}
    main = activities["net.polydance.capture.MainActivity"]
    # One panel since 2026-10-20: the deck and the inbox share MainActivity; no panel opens a task of its own. Quest
    # also has the immersive viewer, which is not a panel (checked below).
    immersive_name = "net.polydance.capture.ImmersiveTableActivity"
    ours = {name: a for name, a in activities.items() if name.startswith("net.polydance.capture.")}
    assert set(ours) == {"net.polydance.capture.MainActivity", "net.polydance.capture.PlayerActivity"} | ({immersive_name} if flavor == "quest" else set()), sorted(ours)
    assert all(a.get(ANDROID + "taskAffinity") is None for name, a in ours.items() if name != immersive_name)
    assert main.get(ANDROID + "exported") == "true"
    assert main.get(ANDROID + "launchMode") == "singleTask"
    assert main.get(ANDROID + "resizeableActivity") == "true"
    layout = main.find("layout")
    assert layout is not None and layout.get(ANDROID + "defaultWidth") == "1440dp" and layout.get(ANDROID + "defaultHeight") == "900dp"
    recorder = next(s for s in app.findall("service") if s.get(ANDROID + "name") == "net.polydance.capture.RecorderService")
    assert recorder.get(ANDROID + "exported") == "false"
    # mediaProjection for the picture; microphone for the mic with it, and alone for a take with Screen off (Takes).
    assert set(recorder.get(ANDROID + "foregroundServiceType", "").split("|")) == {"microphone", "mediaProjection"}
    if flavor == "quest":
        assert "com.oculus.permission.USE_SCENE" in permissions
        assert {"com.oculus.browser", "com.oculus.vrshell"} <= {p.get(ANDROID + "name") for p in root.findall("queries/package")}
        # Meta's store packaging rules (VRC.Quest.Packaging.1) live in the Quest overlay only.
        assert main.get(ANDROID + "excludeFromRecents") == "true"
        assert any(m.get(ANDROID + "name") == "com.oculus.supportedDevices" for m in app.findall("meta-data"))
        # The immersive scene (Spatial SDK): a VR activity of its own, opened only from a model's Immersive key, while the
        # app stays a panel app in Meta's store (head tracking not required). The deck is a 2D activity, so Horizon OS
        # shows it over the scene (cooperative mode, which needs Horizon OS v69).
        immersive = activities[immersive_name]
        assert immersive.get(ANDROID + "exported") == "false"
        assert immersive.get(ANDROID + "taskAffinity") == "net.polydance.capture.immersive"
        assert "com.oculus.intent.category.VR" in {c.get(ANDROID + "name") for c in immersive.findall("intent-filter/category")}
        assert not any("com.oculus.intent.category.VR" in {c.get(ANDROID + "name") for c in a.findall("intent-filter/category")}
                       for name, a in activities.items() if name != immersive_name)
        features = {f.get(ANDROID + "name"): f.get(ANDROID + "required") for f in root.findall("uses-feature")}
        assert features.get("android.hardware.vr.headtracking") == "false", features
        assert features.get("android.hardware.vulkan.version") == "true", features
        assert "com.oculus.intent.category.2D" in {c.get(ANDROID + "name") for c in main.findall("intent-filter/category")}
        assert "69" in {e.get("{http://schemas.horizonos/sdk}minSdkVersion") for e in root.iter("{http://schemas.horizonos/sdk}uses-horizonos-sdk")}
    else:
        assert "oculus" not in path.read_text().lower()
        assert main.get(ANDROID + "excludeFromRecents") is None
        assert "com.android.vending" in {p.get(ANDROID + "name") for p in root.findall("queries/package")}
        assert not {"android.permission.USE_BIOMETRIC", "android.permission.USE_FINGERPRINT"} & permissions
        features = {f.get(ANDROID + "name"): f.get(ANDROID + "required") for f in root.findall("uses-feature")}
        assert features.get("android.hardware.touchscreen") == "false"
        assert not any(key and ("openxr" in key or "xr.api.spatial" in key) for key in features)
    print(f"{name}: shared capture service and isolated platform manifest verified")

assert versions[0][0] == versions[1][0]
assert versions[0][1] + "-androidxr" == versions[1][1]
