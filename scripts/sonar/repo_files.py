"""Only files the repository tracks are read or written by the scripts in this folder (run from the
repository root); the name used is the repository's own, never the command-line argument."""
import os
import subprocess
import sys

ROOT = os.path.realpath(os.getcwd())
TRACKED = subprocess.run(['git', 'ls-files'], capture_output=True, text=True, check=True).stdout.splitlines()


def inside_root(path):
    wanted = os.path.relpath(os.path.realpath(path), ROOT).replace(os.sep, '/')
    for name in TRACKED:
        if name == wanted:
            return name
    sys.exit(f'not a file of the repository: {path}')
