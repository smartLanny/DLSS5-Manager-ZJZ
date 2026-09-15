"""Obtain only the code-pinned public ReShade fixture. Never execute its installer.

This is CI test setup, not a Manager component updater or distribution pack.
"""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

URL = 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe'
ARCHIVE_SHA = 'afe4c8f13048306307983b8b3d41d5bf00a86820440b0e57dea10950e1176445'
DLL_SHA = '0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7'
MAX_BYTES = 64 * 1024 * 1024
TARGET = Path(__file__).resolve().parents[1] / 'payload/nr-before-sr/fixed/RTX50/ReShade64.dll'


def main():
    if TARGET.exists():
        if TARGET.is_symlink() or hashlib.sha256(TARGET.read_bytes()).hexdigest() != DLL_SHA:
            raise RuntimeError('Refusing to overwrite an unrelated fixture')
        return
    request = urllib.request.Request(URL, headers={
        'User-Agent': 'DLSS5-Manager-CI/1.0 (+https://github.com/smartLanny/DLSS5-Manager-ZJZ)',
        'Referer': 'https://reshade.me/',
        'Accept': 'application/octet-stream,*/*;q=0.8',
    })
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA:
        raise RuntimeError('Pinned public ReShade archive digest mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = [entry for entry in archive.infolist() if entry.filename == 'ReShade64.dll']
        if len(entries) != 1 or entries[0].file_size > 16 * 1024 * 1024:
            raise RuntimeError('Unexpected ReShade archive entry')
        dll = archive.read(entries[0])
    if hashlib.sha256(dll).hexdigest() != DLL_SHA:
        raise RuntimeError('Pinned ReShade64.dll digest mismatch')
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with TARGET.open('xb') as output:
        output.write(dll)
    print('Pinned ReShade fixture prepared; installer was not executed.')


if __name__ == '__main__':
    main()
