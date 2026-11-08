#!/usr/bin/env python3
"""Build the real-API iOS app; Apple login remains in Xcode, never in this tool."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def validate_config(config):
    from urllib.parse import urlsplit

    required = {"FIREBASE_PROJECT_ID", "FIREBASE_APP_ID", "FIREBASE_API_KEY", "API_BASE_URL"}
    if not isinstance(config, dict) or not required <= config.keys():
        raise ValueError("Missing required iOS configuration fields")
    if set(config) - (required | {"PATIENT_FACILITY_ID"}):
        raise ValueError("Unexpected configuration fields; never embed credentials")
    if any(not isinstance(v, str) or not v.strip() for v in config.values()):
        raise ValueError("Configuration values must be non-empty strings")
    if config["FIREBASE_PROJECT_ID"] != "project-7efcc4c4-6c86-490c-ba5":
        raise ValueError("Only the designated Firebase project is supported")
    if not re.fullmatch(r"1:842827776169:ios:[a-zA-Z0-9]+", config["FIREBASE_APP_ID"]):
        raise ValueError("Use the registered Firebase iOS app, not a Web app")
    uri = urlsplit(config["API_BASE_URL"])
    if (uri.scheme != "https" or not uri.hostname or uri.username or uri.password
            or uri.path or uri.query or uri.fragment
            or config["API_BASE_URL"].endswith("/")):
        raise ValueError("API_BASE_URL must be an HTTPS origin without a path")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Ignored local JSON file")
    parser.add_argument("--build-number", required=True, type=int)
    parser.add_argument("--flutter", default=os.environ.get("FLUTTER_BIN", "flutter"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--unsigned", action="store_true", help="Compile archive only; not installable")
    mode.add_argument("--team", help="Apple Team ID confirmed by the account owner")
    parser.add_argument("--export-options", type=Path, help="ExportOptions.plist from Xcode")
    args = parser.parse_args()
    if args.build_number < 1:
        parser.error("build number must be positive and unused in App Store Connect")
    if args.team and not re.fullmatch(r"[A-Z0-9]{10}", args.team):
        parser.error("team must be an Apple Team ID")
    if args.unsigned and args.export_options:
        parser.error("unsigned archives cannot be exported to an installable IPA")
    config_path = args.config.resolve(strict=True)
    config = json.loads(config_path.read_text())
    validate_config(config)
    if args.team and (any("REPLACE" in value for value in config.values())
                      or ".test" in config["API_BASE_URL"]):
        parser.error("signed builds require real iOS and API settings, not example values")
    export_options = args.export_options.resolve(strict=True) if args.export_options else None
    patient = Path(__file__).resolve().parent.parent
    build = [args.flutter, "build", "ipa" if args.unsigned else "ios", "--release",
             "--no-codesign", "--target=lib/main_public.dart",
             f"--dart-define-from-file={config_path}", f"--build-number={args.build_number}"]
    if args.team:
        build.append("--config-only")
    # The official plugin's Swift package selects FirebaseAnalyticsCore when
    # this variable is present, excluding advertising identifier support.
    build_env = {**os.environ, "FIREBASE_ANALYTICS_WITHOUT_ADID": "true"}
    subprocess.run(build, cwd=patient, check=True, env=build_env)
    if args.unsigned:
        print("Unsigned archive compiled. It cannot be installed or uploaded to TestFlight.")
        return
    archive = patient / "build/ios/archive/Runner.xcarchive"
    subprocess.run([
        "xcodebuild", "-workspace", "ios/Runner.xcworkspace", "-scheme", "Runner",
        "-configuration", "Release", "-destination", "generic/platform=iOS",
        "-archivePath", str(archive), "-allowProvisioningUpdates",
        f"DEVELOPMENT_TEAM={args.team}", "CODE_SIGN_STYLE=Automatic", "archive",
    ], cwd=patient, check=True, env=build_env)
    if export_options:
        subprocess.run([
            "xcodebuild", "-exportArchive", "-archivePath", str(archive),
            "-exportOptionsPlist", str(export_options),
            "-exportPath", str(patient / "build/ios/ipa"), "-allowProvisioningUpdates",
        ], cwd=patient, check=True, env=build_env)
    else:
        print(f"Signed archive: {archive}. Open in Xcode Organizer to distribute.")


if __name__ == "__main__":
    main()
