from app.config import get_settings
from app.llm.providers._openai_compatible import OpenAICompatibleProvider

settings = get_settings()


class CerebrasProvider(OpenAICompatibleProvider):
    def __init__(self):
        super().__init__(base_url="https://api.cerebras.ai/v1", api_key=settings.CEREBRAS_API_KEY)
