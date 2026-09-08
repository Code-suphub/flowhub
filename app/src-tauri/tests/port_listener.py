"""Owned TCP/UDP listener fixture. Keep both sockets reserved until termination."""
import errno
import socket
import sys
import time

forced_conflicts = int(sys.argv[1]) if len(sys.argv) > 1 else 0
for attempt in range(32):
    tcp = socket.socket()
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blocker = None
    try:
        tcp.bind(("127.0.0.1", 0))
        port = tcp.getsockname()[1]
        if attempt < forced_conflicts:
            blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            blocker.bind(("127.0.0.1", port))
        udp.bind(("127.0.0.1", port))
        tcp.listen()
    except OSError as error:
        tcp.close()
        udp.close()
        if error.errno != errno.EADDRINUSE:
            raise
    else:
        print(port, flush=True)
        time.sleep(60)
        break
    finally:
        if blocker is not None:
            blocker.close()
else:
    sys.exit("TCP/UDP listener allocation exhausted after 32 attempts")
