"""Streaming .npy writer with the same file layout as packages/selfplay/src/npy.ts (format 1.0, 256-byte header
patched with the row count on close), so arrays written here and by `export` are byte-comparable."""
from __future__ import annotations

import numpy as np

HEADER_BYTES = 256
FLUSH_BYTES = 8 << 20


def header(dtype: str, shape: list[int]) -> bytes:
    dims = f"({shape[0]},)" if len(shape) == 1 else f"({', '.join(map(str, shape))})"
    body = f"{{'descr': '{dtype}', 'fortran_order': False, 'shape': {dims}, }}".ljust(HEADER_BYTES - 10 - 1) + "\n"
    if len(body) != HEADER_BYTES - 10:
        raise ValueError(f"npy header too long for shape {dims}")
    return b"\x93NUMPY" + bytes([1, 0]) + len(body).to_bytes(2, "little") + body.encode("latin1")


class NpyWriter:
    def __init__(self, path, dtype: str, row_shape: list[int]):
        self.path, self.dtype, self.row_shape = path, dtype, list(row_shape)
        self.np_dtype = np.dtype(dtype)
        self.f = open(path, "wb")
        self.f.write(header(dtype, [0, *self.row_shape]))
        self.rows = 0
        self.pending: list[bytes] = []
        self.pending_bytes = 0

    def append(self, values: np.ndarray):
        a = np.ascontiguousarray(values, dtype=self.np_dtype)
        size = int(np.prod(self.row_shape)) if self.row_shape else 1
        if a.size % size:
            raise ValueError(f"{self.path}: {a.size} values is not a whole number of rows of {size}")
        self.rows += a.size // size
        b = a.tobytes()
        self.pending.append(b)
        self.pending_bytes += len(b)
        if self.pending_bytes >= FLUSH_BYTES:
            self.flush()

    def flush(self):
        if self.pending:
            self.f.write(b"".join(self.pending))
            self.pending, self.pending_bytes = [], 0

    def close(self):
        self.flush()
        self.f.seek(0)
        self.f.write(header(self.dtype, [self.rows, *self.row_shape]))
        self.f.close()
