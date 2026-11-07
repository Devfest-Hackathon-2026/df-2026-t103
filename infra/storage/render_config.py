"""Render a Storage configuration proposal; never contacts or changes GCP."""

import argparse
import json
import ipaddress
import re
import urllib.parse

PROJECT_ID = "project-7efcc4c4-6c86-490c-ba5"


def build_config(origins, retention_days, upload_doc_ttl_days):
    if type(retention_days) is not int or type(upload_doc_ttl_days) is not int:
        raise ValueError("retention and upload TTL must be integers")
    if upload_doc_ttl_days < 1 or retention_days <= upload_doc_ttl_days:
        raise ValueError("retention must exceed the positive upload document TTL")
    if not origins:
        raise ValueError("at least one approved patient HTTPS origin is required")
    approved = []
    for origin in origins:
        url = urllib.parse.urlsplit(origin)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.path or url.query or url.fragment or "*" in origin
                or any(c.isspace() for c in origin) or "\\" in origin
                or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", url.hostname)
                or len(url.hostname) > 253
                or url.hostname.endswith(".invalid")
                or url.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise ValueError("origins must be exact approved public HTTPS origins")
        # Validate the port as well as URL syntax. Reject an empty explicit port.
        port = url.port
        if (port is not None and not 1 <= port <= 65535) or origin.endswith(":"):
            raise ValueError("invalid origin port")
        try:
            ipaddress.ip_address(url.hostname)
        except ValueError:
            pass
        else:
            raise ValueError("use the approved public DNS origin, not an IP address")
        authority = url.hostname if port in (None, 443) else f"{url.hostname}:{port}"
        if origin != f"https://{authority}":
            raise ValueError("use the canonical browser origin (lowercase DNS, no default port)")
        if origin not in approved:
            approved.append(origin)
    return {
        "project": PROJECT_ID,
        "cors": [{
            "origin": approved,
            "method": ["PUT"],
            "responseHeader": ["Content-Type", "x-goog-if-generation-match"],
            "maxAgeSeconds": 300,
        }],
        "lifecycle": {"rule": [{
            "action": {"type": "Delete"},
            "condition": {"age": retention_days, "matchesPrefix": ["patient-uploads/"]},
        }]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", action="append", required=True)
    parser.add_argument("--retention-days", type=int, required=True)
    parser.add_argument("--upload-doc-ttl-days", type=int, required=True)
    args = parser.parse_args()
    try:
        config = build_config(args.origin, args.retention_days, args.upload_doc_ttl_days)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(config, indent=2))


if __name__ == "__main__":
    main()
