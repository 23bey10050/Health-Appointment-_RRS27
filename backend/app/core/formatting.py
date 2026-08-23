from collections import defaultdict


class BlankOnMissing(defaultdict):
    """A format_map mapping where a referenced-but-missing key renders as an empty
    string instead of raising KeyError. Shared by email subject rendering
    (services/email_render.py) and prompt template rendering (llm/prompt_loader.py)
    -- both would rather ship a blank than 500 on an operator's typo'd context key."""

    def __missing__(self, key):
        return ""
