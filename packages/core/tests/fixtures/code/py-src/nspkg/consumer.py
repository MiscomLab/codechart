"""The namespace package has no `__init__.py`: `from nspkg import plugin` names its module."""

from nspkg import plugin
from nspkg.common import log


def main() -> str:
    return plugin.run("hi") + log("done")
