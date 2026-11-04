import re
import shutil
import subprocess


def llvm_strip(*, exact=None):
    for name in ("llvm-strip-20", "llvm-strip-19", "llvm-strip-18", "llvm-strip"):
        path = shutil.which(name)
        if not path:
            continue
        try:
            output = subprocess.check_output([path, "--version"], text=True, stderr=subprocess.STDOUT)
        except (OSError, subprocess.CalledProcessError):
            continue
        match = re.search(r"LLVM version\s+(\d+\.\d+\.\d+)", output)
        if match and (match.group(1) == exact if exact else match.group(1).split('.')[0] in ('18', '19', '20')):
            return path, match.group(1)
    requirement = exact or '18, 19 or 20'
    raise ValueError(f"LLVM strip {requirement} is required")
