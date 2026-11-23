"""A job that reaches the package root with a two-dot relative import."""

from ..policies import allow


def nightly() -> bool:
    return allow(1.0)
