"""Delove GPU self-play: a training-only mirror of the Risk rules (packages/engine) on GPU tensors.

The TypeScript engine is the authority; this mirror is trusted only as far as tests/replay.py shows it plays the
same games. Never imported by the server, the client or the character code; never used for live games.
"""
