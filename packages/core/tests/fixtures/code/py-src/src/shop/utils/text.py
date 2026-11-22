"""Small string helpers."""


def slug(text: str) -> str:
    return text.lower().replace(" ", "-")


def pad(text: str, amount: float) -> str:
    return f"{text}:{amount}"
