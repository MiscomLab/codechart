"""Shop package: re-exports the billing API so callers can `from shop import …`."""

from .billing import charge
from .utils import slug

__all__ = ["charge", "slug"]
