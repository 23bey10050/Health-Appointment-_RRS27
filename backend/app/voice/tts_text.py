"""Text normalisation before TTS -- IMPLEMENTATION.md section 10.4: "Piper reads
raw numerals literally and will mispronounce them in clinical contexts if you
don't expand them first." Deliberately narrow: only the patterns the voice agent
actually produces (times, common abbreviations), not a general-purpose text
normaliser.
"""

import re

_TIME_RE = re.compile(r"\b(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\b")
_ABBREVIATIONS = {
    r"\bDr\.": "Doctor",
    r"\bMr\.": "Mister",
    r"\bMrs\.": "Missus",
    r"\bMs\.": "Miz",
    r"\bmg\b": "milligrams",
    r"\bkg\b": "kilograms",
}

_NUMBER_WORDS = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen", "twenty",
]


def _hour_word(h: int) -> str:
    h12 = h % 12
    if h12 == 0:
        h12 = 12
    return _NUMBER_WORDS[h12] if h12 < len(_NUMBER_WORDS) else str(h12)


def _minute_words(m: int) -> str:
    if m == 0:
        return "o'clock"
    if m == 15:
        return "fifteen"
    if m == 30:
        return "thirty"
    if m == 45:
        return "forty-five"
    if m < 10:
        return f"oh {_NUMBER_WORDS[m]}" if m < len(_NUMBER_WORDS) else str(m)
    if m <= 20:
        return _NUMBER_WORDS[m] if m < len(_NUMBER_WORDS) else str(m)
    tens = (m // 10) * 10
    ones = m % 10
    tens_word = {20: "twenty", 30: "thirty", 40: "forty", 50: "fifty"}.get(tens, str(tens))
    return f"{tens_word} {_NUMBER_WORDS[ones]}" if ones else tens_word


def _expand_time(match: re.Match) -> str:
    hour, minute, meridiem = int(match.group(1)), int(match.group(2)), match.group(3)
    spoken = f"{_hour_word(hour)} {_minute_words(minute)}"
    if meridiem:
        spoken += f" {'A M' if meridiem.upper() == 'AM' else 'P M'}"
    return spoken


def normalize_for_tts(text: str) -> str:
    result = _TIME_RE.sub(_expand_time, text)
    for pattern, replacement in _ABBREVIATIONS.items():
        result = re.sub(pattern, replacement, result)
    return result
