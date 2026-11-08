"""Deploy only the existing Singapore status database's checked-in rules."""
import argparse
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True,
                        choices=["project-7efcc4c4-6c86-490c-ba5"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    rules = json.loads((root / "firebase/database.rules.json").read_text())
    token = subprocess.check_output(
        ["gcloud", "auth", "print-access-token", "--project", args.project],
        text=True,
    ).strip()
    url = (f"https://{args.project}-status.asia-southeast1.firebasedatabase.app"
           "/.settings/rules.json")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    # The Firebase CLI uses this same endpoint/query for syntax validation.
    request = urllib.request.Request(
        url + ("?dryRun=true" if args.dry_run else ""),
        data=json.dumps(rules).encode(), headers=headers, method="PUT",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read()
    if not args.dry_run:
        with urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=30,
        ) as response:
            if json.load(response) != rules:
                raise RuntimeError("Published database rules differ from checked-in rules")
    print("Status database rules: " + ("syntax valid (dry run)" if args.dry_run else "deployed and verified"))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        # Never log credentials or a response body containing internal details.
        raise SystemExit(f"Database rules request failed: HTTP {error.code}") from None
