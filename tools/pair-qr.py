#!/usr/bin/env python3
"""Print a QR code that pairs jPhone in one scan. Standard library only.

    tools/pair-qr.py                 # runs `jcode pair`, jPhone on http://<tailscale-ip>:8765
    tools/pair-qr.py --https         # jPhone and gateway behind `tailscale serve` (tools/https-setup.sh)
    tools/pair-qr.py --app http://100.101.102.103:8765 --gateway 100.101.102.103:7643
    tools/pair-qr.py --code 123456   # use a code you already have instead of running `jcode pair`

The QR code encodes a link like

    http://100.101.102.103:8765/#pair=100.101.102.103:7643:123456

Scanning it opens jPhone with the host, port and code filled in; you confirm
with one tap. The part after # never leaves the phone (browsers do not send
it to the server), and jPhone removes it from the address bar after reading it.
The code inside is single use and expires after 5 minutes, but until then it
is as good as typing it: do not share the QR code or the link.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys


# --------------------------------------------------------------------------
# Minimal QR encoder: byte mode, error correction level M, versions 1-10
# (up to 213 bytes, plenty for a pairing link). Follows ISO/IEC 18004 and the
# structure of Project Nayuki's reference implementation (MIT).
# --------------------------------------------------------------------------

ECC_PER_BLOCK_M = [None, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
NUM_BLOCKS_M = [None, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
FORMAT_BITS_M = 0  # ECC level M in the format information


def _gf_mul(x, y):
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree):
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 0x02)
    return result


def _rs_remainder(data, divisor):
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


def _raw_modules(ver):
    result = (16 * ver + 128) * ver + 64
    if ver >= 2:
        n = ver // 7 + 2
        result -= (25 * n - 10) * n - 55
        if ver >= 7:
            result -= 36
    return result


def _data_codewords(ver):
    return _raw_modules(ver) // 8 - ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver]


def _align_positions(ver, size):
    if ver == 1:
        return []
    n = ver // 7 + 2
    step = (ver * 4 + n * 2 + 1) // (n * 2 - 2) * 2
    return sorted([size - 7 - i * step for i in range(n - 1)] + [6])


def qr_matrix(text):
    """Return the QR code for `text` as a list of rows of booleans (True = dark)."""
    data = text.encode("utf-8")
    for ver in range(1, 11):
        count_bits = 8 if ver < 10 else 16
        if 4 + count_bits + 8 * len(data) <= _data_codewords(ver) * 8:
            break
    else:
        raise ValueError("text too long for this QR encoder (max ~200 bytes)")

    # Data bits: byte mode, length, payload, terminator, padding.
    bits = []

    def put(val, n):
        bits.extend((val >> i) & 1 for i in reversed(range(n)))

    put(0b0100, 4)
    put(len(data), count_bits)
    for b in data:
        put(b, 8)
    capacity = _data_codewords(ver) * 8
    put(0, min(4, capacity - len(bits)))
    put(0, (-len(bits)) % 8)
    pad = 0xEC
    while len(bits) < capacity:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    codewords = [int("".join(map(str, bits[i : i + 8])), 2) for i in range(0, len(bits), 8)]

    # Split into blocks, add Reed-Solomon ECC, interleave.
    nblocks, ecclen = NUM_BLOCKS_M[ver], ECC_PER_BLOCK_M[ver]
    raw = _raw_modules(ver) // 8
    nshort = nblocks - raw % nblocks
    shortlen = raw // nblocks
    div = _rs_divisor(ecclen)
    blocks, k = [], 0
    for i in range(nblocks):
        dat = codewords[k : k + shortlen - ecclen + (0 if i < nshort else 1)]
        k += len(dat)
        ecc = _rs_remainder(dat, div)
        if i < nshort:
            dat = dat + [0]
        blocks.append(dat + ecc)
    final = []
    for i in range(len(blocks[0])):
        for j, blk in enumerate(blocks):
            if i != shortlen - ecclen or j >= nshort:
                final.append(blk[i])

    size = ver * 4 + 17
    mods = [[False] * size for _ in range(size)]
    func = [[False] * size for _ in range(size)]

    def setf(x, y, dark):
        mods[y][x] = dark
        func[y][x] = True

    for i in range(size):  # timing patterns
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):  # finders + separators
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    pos = _align_positions(ver, size)
    last = len(pos) - 1
    for i, ay in enumerate(pos):
        for j, ax in enumerate(pos):
            if (i, j) in ((0, 0), (0, last), (last, 0)):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    setf(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)

    def draw_format(mask):
        d = FORMAT_BITS_M << 3 | mask
        rem = d
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        b = (d << 10 | rem) ^ 0x5412
        bit = lambda i: (b >> i) & 1 == 1
        for i in range(6):
            setf(8, i, bit(i))
        setf(8, 7, bit(6))
        setf(8, 8, bit(7))
        setf(7, 8, bit(8))
        for i in range(9, 15):
            setf(14 - i, 8, bit(i))
        for i in range(8):
            setf(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            setf(8, size - 15 + i, bit(i))
        setf(8, size - 8, True)  # dark module

    draw_format(0)  # reserve the format areas
    if ver >= 7:
        rem = ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        vb = ver << 12 | rem
        for i in range(18):
            dark = (vb >> i) & 1 == 1
            a, b = size - 11 + i % 3, i // 3
            setf(a, b, dark)
            setf(b, a, dark)

    # Place codewords in the zigzag.
    i, right = 0, size - 1
    total = len(final) * 8
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = size - 1 - vert if upward else vert
                if not func[y][x] and i < total:
                    mods[y][x] = (final[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2

    masks = [
        lambda x, y: (x + y) % 2 == 0,
        lambda x, y: y % 2 == 0,
        lambda x, y: x % 3 == 0,
        lambda x, y: (x + y) % 3 == 0,
        lambda x, y: (x // 3 + y // 2) % 2 == 0,
        lambda x, y: x * y % 2 + x * y % 3 == 0,
        lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
        lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
    ]

    def apply(m):
        for y in range(size):
            for x in range(size):
                if not func[y][x] and masks[m](x, y):
                    mods[y][x] = not mods[y][x]

    def penalty():
        # Runs of 5+ same-colored modules, 2x2 blocks and dark/light balance.
        # (Any mask is valid; this only helps phone cameras.)
        p = 0
        for line in mods + [list(c) for c in zip(*mods)]:
            run = 1
            for a, b in zip(line, line[1:]):
                if a == b:
                    run += 1
                else:
                    p += run - 2 if run >= 5 else 0
                    run = 1
            p += run - 2 if run >= 5 else 0
        for y in range(size - 1):
            for x in range(size - 1):
                c = mods[y][x]
                if c == mods[y][x + 1] == mods[y + 1][x] == mods[y + 1][x + 1]:
                    p += 3
        dark = sum(map(sum, mods))
        p += abs(dark * 20 - size * size * 10) // (size * size) * 10
        return p

    best = None
    for m in range(8):
        apply(m)
        draw_format(m)
        score = penalty()
        if best is None or score < best[0]:
            best = (score, m)
        apply(m)  # XOR again to undo
    apply(best[1])
    draw_format(best[1])
    return mods


def render(matrix, color=True, quiet=2):
    """Two modules per character cell, using half blocks. Light modules are drawn."""
    size = len(matrix)
    light = lambda x, y: not (0 <= x < size and 0 <= y < size and matrix[y][x])
    out = []
    for y in range(-quiet, size + quiet, 2):
        row = ""
        for x in range(-quiet, size + quiet):
            top, bot = light(x, y), light(x, y + 1)
            row += "█" if top and bot else "▀" if top else "▄" if bot else " "
        out.append("\x1b[97;40m" + row + "\x1b[0m" if color else row)
    return "\n".join(out)


# --------------------------------------------------------------------------
# Pairing
# --------------------------------------------------------------------------

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run_jcode_pair():
    exe = shutil.which("jcode")
    if not exe:
        sys.exit("jcode is not on PATH. Run `jcode pair` yourself and pass --code.")
    p = subprocess.run([exe, "pair"], capture_output=True, text=True, timeout=30)
    text = ANSI.sub("", p.stdout + p.stderr)
    code = re.search(r"Pairing code:\s*(\d{3})\s?(\d{3})", text)
    host = re.search(r"Connect host:\s*(\S+)", text)
    if not code:
        sys.exit("Could not read a pairing code from `jcode pair`:\n" + text)
    if "Gateway is disabled" in text:
        print("! jcode's gateway is disabled, so this code will not work yet. See the README.", file=sys.stderr)
    return code.group(1) + code.group(2), host.group(1) if host else None


def tailscale(*args):
    for exe in (shutil.which("tailscale"), "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        if exe and os.path.exists(exe):
            try:
                return subprocess.run([exe, *args], capture_output=True, text=True, timeout=5).stdout
            except Exception:
                pass
    return ""


def tailscale_dns_name():
    try:
        return json.loads(tailscale("status", "--json"))["Self"]["DNSName"].rstrip(".") or None
    except Exception:
        return None


def is_loopback_or_unknown(host):
    return not host or host.startswith("127.") or host in ("localhost", "::1", "0.0.0.0", "::", "<this-machine>")


def main():
    ap = argparse.ArgumentParser(description="Print a QR code that pairs jPhone with this Mac's jcode.")
    ap.add_argument("--https", action="store_true", help="jPhone and gateway are behind tailscale serve (https://<magicdns>)")
    ap.add_argument("--app", help="jPhone URL the phone should open (default: http://<tailscale-ip>:8765, or https://<magicdns> with --https)")
    ap.add_argument("--gateway", help="gateway HOST:PORT the phone should pair with (default: from `jcode pair`)")
    ap.add_argument("--code", help="use this 6-digit code instead of running `jcode pair`")
    ap.add_argument("--no-color", action="store_true", help="plain characters (for light-on-dark terminals that strip colors)")
    ap.add_argument("--print-matrix", action="store_true", help=argparse.SUPPRESS)  # tests
    args = ap.parse_args()

    if args.code:
        code, jhost = re.sub(r"\D", "", args.code), None
        if len(code) != 6:
            sys.exit("--code needs 6 digits")
    else:
        code, jhost = run_jcode_pair()

    dns = tailscale_dns_name() if args.https or not args.app else None
    ts_ip = (tailscale("ip", "-4").strip().splitlines() or [None])[0]

    if args.gateway:
        gw = args.gateway
    elif args.https:
        if not dns:
            sys.exit("Could not find this machine's Tailscale name. Pass --gateway NAME.ts.net:7643.")
        gw = f"{dns}:7643"  # the certificate is for the MagicDNS name
    else:
        host = jhost.rsplit(":", 1)[0] if jhost else None
        port = jhost.rsplit(":", 1)[1] if jhost and ":" in jhost else "7643"
        if is_loopback_or_unknown(host):
            host = ts_ip
        if not host:
            sys.exit("Could not work out the gateway address. Pass --gateway HOST:PORT.")
        gw = f"{host}:{port}"

    if args.app:
        app = args.app
    elif args.https:
        app = f"https://{dns}/"
    elif ts_ip:
        app = f"http://{ts_ip}:8765/"
    else:
        sys.exit("Could not find a Tailscale IP. Pass --app URL.")

    link = app.split("#")[0].rstrip("/") + "/#pair=" + gw + ":" + code
    try:
        matrix = qr_matrix(link)
    except ValueError as e:
        sys.exit(f"{e}. The link is:\n  {link}")
    if args.print_matrix:
        print("\n".join("".join("1" if c else "0" for c in row) for row in matrix))
        return
    print()
    print(render(matrix, color=not args.no_color))
    print()
    print("  Scan with your phone's camera, check the host, tap Pair.")
    print(f"  Code {code[:3]} {code[3:]} for {gw}. Expires in 5 minutes. Do not share this QR code.")
    print(f"  {link}")
    print()


if __name__ == "__main__":
    main()
