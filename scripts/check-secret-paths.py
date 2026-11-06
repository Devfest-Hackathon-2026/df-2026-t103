"""Reject tracked local environment files without printing their contents."""

import pathlib
import subprocess
import sys

paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
blocked = []
for path in filter(None, paths):
    name = pathlib.PurePosixPath(path).name
    if name in {".env.example", ".secret.example"}:
        continue
    if name in {".env", ".secret"} or name.startswith((".env.", ".secret.")):
        blocked.append(path)

if blocked:
    print("Local environment/secret files must not be tracked:", file=sys.stderr)
    for path in blocked:
        print(repr(path), file=sys.stderr)
    sys.exit(1)
print("No tracked local environment/secret files")
