"""Print missing imports when a Windows native test fails before main()."""
import ctypes
from pathlib import Path

import pefile

binary = max(Path("apps/desktop/src-tauri/target/debug/deps").glob("pier_desktop_lib-*.exe"), key=lambda path: path.stat().st_mtime)
print("Checking:", binary)
pe = pefile.PE(str(binary))
get_proc = ctypes.windll.kernel32.GetProcAddress
get_proc.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
get_proc.restype = ctypes.c_void_p
get_path = ctypes.windll.kernel32.GetModuleFileNameW
get_path.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32]
get_path.restype = ctypes.c_uint32
for group in pe.DIRECTORY_ENTRY_IMPORT:
    name = group.dll.decode()
    try:
        library = ctypes.WinDLL(name, winmode=0)
        path = ctypes.create_unicode_buffer(32768)
        get_path(library._handle, path, len(path))
        print(name, "=>", path.value)
        for entry in group.imports:
            symbol = ctypes.cast(ctypes.c_char_p(entry.name), ctypes.c_void_p) if entry.name else entry.ordinal
            if not get_proc(library._handle, symbol):
                print("MISSING ENTRY:", name, entry.name or entry.ordinal)
    except OSError as error:
        print("LOAD FAILED:", name, error)
