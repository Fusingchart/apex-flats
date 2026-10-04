#!/usr/bin/env python3
"""Downsample assets/sky/sky_4k.hdr to a 2048x1024 RLE Radiance file (assets/sky/sky_2k.hdr) for the standalone build."""
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC, DST = ROOT / 'assets/sky/sky_4k.hdr', ROOT / 'assets/sky/sky_2k.hdr'


def read_hdr(path: Path) -> np.ndarray:
    data = path.read_bytes()
    p = 0

    def line() -> str:
        nonlocal p
        end = data.index(b'\n', p)
        s = data[p:end].decode('latin-1')
        p = end + 1
        return s

    assert line().startswith('#?')
    while line() != '':
        pass
    _, h, _, w = line().split()
    H, W = int(h), int(w)
    out = np.zeros((H, W, 4), np.uint8)
    buf = np.frombuffer(data, np.uint8)
    for y in range(H):
        assert buf[p] == 2 and buf[p + 1] == 2
        p += 4
        for c in range(4):
            x = 0
            row = out[y, :, c]
            while x < W:
                n = int(buf[p]); p += 1
                if n > 128:
                    n -= 128
                    row[x:x + n] = buf[p]; p += 1
                else:
                    row[x:x + n] = buf[p:p + n]; p += n
                x += n
    return out


def rgbe_to_float(rgbe: np.ndarray) -> np.ndarray:
    e = rgbe[..., 3].astype(np.int32)
    f = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0)
    return rgbe[..., :3].astype(np.float64) * f[..., None]


def float_to_rgbe(img: np.ndarray) -> np.ndarray:
    m = img.max(axis=-1)
    out = np.zeros(img.shape[:2] + (4,), np.uint8)
    ok = m > 1e-32
    mant, ex = np.frexp(m[ok])
    scale = mant * 256.0 / m[ok]
    out[ok, :3] = np.clip(img[ok] * scale[:, None], 0, 255).astype(np.uint8)
    out[ok, 3] = (ex + 128).astype(np.uint8)
    return out


def write_hdr(path: Path, rgbe: np.ndarray) -> None:
    H, W = rgbe.shape[:2]
    parts = [b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n', f'-Y {H} +X {W}\n'.encode()]
    for y in range(H):
        parts.append(bytes([2, 2, W >> 8, W & 255]))
        for c in range(4):
            row = rgbe[y, :, c].tobytes()
            for i in range(0, W, 128):  # literal runs only: valid RLE that every reader accepts
                chunk = row[i:i + 128]
                parts.append(bytes([len(chunk)]) + chunk)
    path.write_bytes(b''.join(parts))


if __name__ == '__main__':
    hdr = rgbe_to_float(read_hdr(SRC))
    H, W = hdr.shape[:2]
    small = hdr.reshape(H // 2, 2, W // 2, 2, 3).mean(axis=(1, 3))
    write_hdr(DST, float_to_rgbe(small))
    print('wrote', DST, small.shape, DST.stat().st_size, 'bytes')
