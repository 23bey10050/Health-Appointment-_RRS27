from app.voice.tts_text import normalize_for_tts


def test_expands_common_time():
    assert normalize_for_tts("Your appointment is at 10:30 AM.") == "Your appointment is at ten thirty A M."


def test_expands_on_the_hour():
    assert "twelve o'clock" in normalize_for_tts("See you at 12:00 PM.")


def test_expands_doctor_abbreviation():
    assert "Doctor Mehta" in normalize_for_tts("Dr. Mehta will see you now.")
    assert "Dr." not in normalize_for_tts("Dr. Mehta will see you now.")


def test_leaves_plain_text_unchanged():
    assert normalize_for_tts("Hello, how can I help you today?") == "Hello, how can I help you today?"
