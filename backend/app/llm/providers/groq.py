from app.config import get_settings
from app.llm.providers._openai_compatible import OpenAICompatibleProvider

settings = get_settings()


class GroqProvider(OpenAICompatibleProvider):
    def __init__(self):
        super().__init__(base_url="https://api.groq.com/openai/v1", api_key=settings.GROQ_API_KEY)
