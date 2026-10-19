"""The engine's PRNG (mulberry32, packages/engine/src/rng.ts) on tensors, one stream per game.

mulberry32 adds a constant to its state and hashes the result, so the k-th number after state s is
hash(s + k * 0x6D2B79F5): a counter-based generator. Each game keeps its 32-bit state in an int64 tensor; any number
of draws (a whole round of dice) can be computed at once from the offsets. Same seed and same choices as the
TypeScript engine therefore give exactly the same deal, dice and reshuffles.
"""
import torch

M32 = 0xFFFFFFFF
STEP = 0x6D2B79F5


def _imul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Low 32 bits of a * b for uint32 values held in int64 (Math.imul), split in 16-bit halves so no product
    passes 2^63."""
    a_lo = a & 0xFFFF
    a_hi = a >> 16
    return (a_lo * b + (((a_hi * b) & 0xFFFF) << 16)) & M32


def hash32(t: torch.Tensor) -> torch.Tensor:
    """mulberry32's output for an (already advanced) state t, as uint32 in int64."""
    t = t & M32
    t = _imul(t ^ (t >> 15), t | 1)
    t = t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & M32)
    return (t ^ (t >> 14)) & M32


def nth(state: torch.Tensor, k) -> torch.Tensor:
    """The k-th draw (k >= 1) after `state`, without advancing it. k may be a tensor broadcasting with state."""
    return hash32((state + STEP * k) & M32)


def advance(state: torch.Tensor, k) -> torch.Tensor:
    return (state + STEP * k) & M32


def to_int(u: torch.Tensor, n) -> torch.Tensor:
    """nextInt(rng, n) = floor(u / 2^32 * n), exact in integers."""
    return (u * n) >> 32
