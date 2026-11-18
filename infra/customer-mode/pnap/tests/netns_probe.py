"""Tiny TCP/UDP helpers run inside network namespaces by netns_scenario.py (no third-party tools).

  listen IP:PORT [IP:PORT ...]       accept TCP connections and answer "hi" (runs until killed)
  connect IP PORT [SRC] [TIMEOUT]    print "ok" if a TCP connection gets "hi", else "fail <reason>"
  hold IP PORT COUNT                 open COUNT connections, keep them open, print how many got "hi"
  burst IP PORT COUNT                COUNT short connections as fast as possible, print how many got "hi"
  syn SRC DST PORT COUNT             send COUNT raw TCP SYNs from SRC (any address: a raw socket, no routing check
                                     on the source), print how many were sent
"""

import struct

import socket
import sys
import threading
import time


def serve(sock):
    while True:
        c, _ = sock.accept()
        try:
            c.sendall(b"hi")
        finally:
            threading.Thread(target=lambda c=c: (time.sleep(30), c.close()), daemon=True).start()


def listen(addrs):
    for a in addrs:
        ip, port = a.rsplit(":", 1)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((ip, int(port)))
        s.listen(512)
        threading.Thread(target=serve, args=(s,), daemon=True).start()
    print("listening", flush=True)
    while True:
        time.sleep(3600)


def connect(ip, port, src=None, timeout=1.0, keep=None):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        if src:
            s.setsockopt(socket.SOL_IP, 15, 1)  # IP_FREEBIND: send from an address the namespace does not own
            s.bind((src, 0))
        s.connect((ip, int(port)))
        ok = s.recv(2) == b"hi"
        if keep is not None and ok:
            keep.append(s)
        else:
            s.close()
        return "ok" if ok else "fail no-greeting"
    except OSError as e:
        s.close()
        return f"fail {type(e).__name__}" + (f" {e.errno}" if e.errno else "")


def csum(b):
    if len(b) % 2:
        b += b"\0"
    s = sum(struct.unpack(f"!{len(b) // 2}H", b))
    s = (s >> 16) + (s & 0xFFFF)
    s += s >> 16
    return ~s & 0xFFFF


def syn(src, dst, port, count):
    sk = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
    sent = 0
    for i in range(count):
        sport = 40000 + i
        tcp = struct.pack("!HHIIBBHHH", sport, port, 1000 + i, 0, 5 << 4, 0x02, 64240, 0, 0)
        pseudo = socket.inet_aton(src) + socket.inet_aton(dst) + struct.pack("!BBH", 0, 6, len(tcp))
        tcp = tcp[:16] + struct.pack("!H", csum(pseudo + tcp)) + tcp[18:]
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp), i, 0, 64, 6, 0, socket.inet_aton(src), socket.inet_aton(dst))
        sk.sendto(ip + tcp, (dst, 0))
        sent += 1
    return sent


if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    if cmd == "listen":
        listen(a)
    elif cmd == "connect":
        print(connect(a[0], a[1], a[2] if len(a) > 2 and a[2] != "-" else None, float(a[3]) if len(a) > 3 else 1.0))
    elif cmd == "hold":
        keep = []
        print(sum(connect(a[0], a[1], timeout=1.0, keep=keep) == "ok" for _ in range(int(a[2]))))
    elif cmd == "syn":
        print(syn(a[0], a[1], int(a[2]), int(a[3])))
    elif cmd == "burst":
        print(sum(connect(a[0], a[1], timeout=0.5) == "ok" for _ in range(int(a[2]))))
