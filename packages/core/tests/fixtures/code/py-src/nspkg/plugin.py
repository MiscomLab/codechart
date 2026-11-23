"""A namespace package module that calls into its sibling."""

from .common import log


def run(message: str) -> str:
    return log(message)
