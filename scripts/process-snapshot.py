#!/usr/bin/python3
"""Trusted process snapshot with a Darwin libproc fallback."""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import datetime
import os
import platform
import struct
import subprocess
import sys
from dataclasses import dataclass


HEADER = "CANVAST_PROCESS_SNAPSHOT_V1"
FIELDS = "pid\tppid\tpgid\tstart_sec\tstart_usec\trss_bytes\tcpu_usec\tcommand"


@dataclass(frozen=True)
class Process:
    pid: int
    ppid: int
    pgid: int
    start_sec: int
    start_usec: int
    rss_bytes: int
    cpu_usec: int
    command: str


def clean_command(value: str) -> str:
    return value.replace("\0", " ").replace("\t", " ").replace("\r", " ").replace("\n", " ")


def cpu_usec(value: str) -> int:
    day_split = value.split("-", 1)
    days = int(day_split[0]) if len(day_split) == 2 else 0
    clock = day_split[-1].split(":")
    seconds = float(clock[-1])
    minutes = int(clock[-2]) if len(clock) >= 2 else 0
    hours = int(clock[-3]) if len(clock) >= 3 else 0
    return int((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000_000)


def load_libproc() -> ctypes.CDLL:
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libproc.proc_listallpids.restype = ctypes.c_int
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
    libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    libproc.proc_pidpath.restype = ctypes.c_int
    return libproc


def bsd_info(libproc: ctypes.CDLL, pid: int) -> ProcBsdInfo:
    info = ProcBsdInfo()
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise RuntimeError(f"proc_pidinfo_failed:{pid}")
    return info


def ps_snapshot(pid: int | None) -> list[Process]:
    ps_bin = os.environ.get("CANVAST_PS_BIN", "ps")
    columns = "pid=,ppid=,pgid=,rss=,time=,lstart=,command="
    arguments = [ps_bin, "-o", columns, "-p", str(pid)] if pid is not None else [ps_bin, "-eo", columns]
    completed = subprocess.run(arguments, check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    if completed.returncode != 0 or not completed.stdout.strip():
        raise RuntimeError("ps_failed")
    records: list[Process] = []
    libproc = load_libproc() if platform.system() == "Darwin" else None
    for line in completed.stdout.splitlines():
        parts = line.strip().split(None, 10)
        if len(parts) < 11:
            raise RuntimeError("ps_malformed")
        process_id, parent_id, group_id, rss_kb = map(int, parts[:4])
        started = datetime.datetime.strptime(" ".join(parts[5:10]), "%a %b %d %H:%M:%S %Y")
        exact = bsd_info(libproc, process_id) if libproc is not None else None
        records.append(Process(
            process_id,
            int(exact.ppid) if exact is not None else parent_id,
            int(exact.pgid) if exact is not None else group_id,
            int(exact.start_sec) if exact is not None else int(started.timestamp()),
            int(exact.start_usec) if exact is not None else 0,
            rss_kb * 1024,
            cpu_usec(parts[4]),
            clean_command(parts[10]),
        ))
    return records


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32),
        ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32),
        ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32),
        ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
        ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64),
        ("start_usec", ctypes.c_uint64),
    ]


class ProcTaskInfo(ctypes.Structure):
    _fields_ = [
        ("virtual_size", ctypes.c_uint64), ("resident_size", ctypes.c_uint64),
        ("total_user", ctypes.c_uint64), ("total_system", ctypes.c_uint64),
        ("threads_user", ctypes.c_uint64), ("threads_system", ctypes.c_uint64),
        ("policy", ctypes.c_int32), ("faults", ctypes.c_int32), ("pageins", ctypes.c_int32),
        ("cow_faults", ctypes.c_int32), ("messages_sent", ctypes.c_int32),
        ("messages_received", ctypes.c_int32), ("syscalls_mach", ctypes.c_int32),
        ("syscalls_unix", ctypes.c_int32), ("csw", ctypes.c_int32),
        ("threadnum", ctypes.c_int32), ("numrunning", ctypes.c_int32), ("priority", ctypes.c_int32),
    ]


def process_arguments(libc: ctypes.CDLL, pid: int, fallback: str) -> str:
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 5:
        return fallback
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        return fallback
    raw = buffer.raw[: size.value]
    argc = struct.unpack_from("i", raw)[0]
    cursor = 4
    executable_end = raw.find(b"\0", cursor)
    if executable_end < 0:
        return fallback
    cursor = executable_end
    while cursor < len(raw) and raw[cursor] == 0:
        cursor += 1
    arguments: list[str] = []
    while cursor < len(raw) and len(arguments) < argc:
        end = raw.find(b"\0", cursor)
        if end < 0:
            break
        arguments.append(raw[cursor:end].decode("utf-8", "replace"))
        cursor = end + 1
    return clean_command(" ".join(arguments) if arguments else fallback)


def libproc_snapshot(pid: int | None) -> list[Process]:
    if platform.system() != "Darwin":
        raise RuntimeError("libproc_unavailable")
    libproc = load_libproc()
    libc = ctypes.CDLL(ctypes.util.find_library("c") or "/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t,
    ]
    libc.sysctl.restype = ctypes.c_int

    if pid is None:
        capacity = max(libproc.proc_listallpids(None, 0) * 2, 1024)
        pid_buffer = (ctypes.c_int * capacity)()
        count = libproc.proc_listallpids(pid_buffer, ctypes.sizeof(pid_buffer))
        if count <= 0:
            raise RuntimeError("proc_listallpids_failed")
        process_ids = sorted(set(value for value in pid_buffer[:count] if value > 0))
    else:
        process_ids = [pid]

    records: list[Process] = []
    for process_id in process_ids:
        try:
            bsd = bsd_info(libproc, process_id)
        except RuntimeError:
            continue
        task = ProcTaskInfo()
        task_size = libproc.proc_pidinfo(process_id, 4, 0, ctypes.byref(task), ctypes.sizeof(task))
        path_buffer = ctypes.create_string_buffer(4096)
        path_size = libproc.proc_pidpath(process_id, path_buffer, ctypes.sizeof(path_buffer))
        fallback = path_buffer.value.decode("utf-8", "replace") if path_size > 0 else bytes(bsd.name).split(b"\0", 1)[0].decode("utf-8", "replace")
        command = process_arguments(libc, process_id, fallback)
        records.append(Process(
            int(bsd.pid), int(bsd.ppid), int(bsd.pgid), int(bsd.start_sec), int(bsd.start_usec),
            int(task.resident_size) if task_size == ctypes.sizeof(task) else 0,
            int((task.total_user + task.total_system) / 1000) if task_size == ctypes.sizeof(task) else 0,
            command,
        ))
    if not records:
        raise RuntimeError("libproc_empty")
    return records


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true")
    group.add_argument("--pid", type=int)
    arguments = parser.parse_args()
    selected_pid = arguments.pid
    force_fallback = os.environ.get("CANVAST_PROCESS_SNAPSHOT_FORCE_FALLBACK") == "1"
    try:
        records = libproc_snapshot(selected_pid) if force_fallback else ps_snapshot(selected_pid)
    except Exception as ps_error:
        try:
            records = libproc_snapshot(selected_pid)
        except Exception as libproc_error:
            print(f"process-snapshot: ps={ps_error}; fallback={libproc_error}", file=sys.stderr)
            return 1
    print(HEADER)
    print(FIELDS)
    for record in records:
        print(
            f"{record.pid}\t{record.ppid}\t{record.pgid}\t{record.start_sec}\t{record.start_usec}"
            f"\t{record.rss_bytes}\t{record.cpu_usec}\t{record.command}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
