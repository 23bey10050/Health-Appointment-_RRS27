"""Tool-calling loop -- IMPLEMENTATION.md section 12: "Tool-calling loop, not
free-form generation. Max 3 tool calls per turn, then force a text response."

Prompted JSON tool-calling, not each provider's native function-calling API: Groq
and Cerebras are OpenAI-compatible, but Gemini and Ollama each have their own
function-calling wire formats, and llm/router.py already has a working, tested
strict-JSON-with-repair path (llm/generate.py) that works identically regardless
of provider. One JSON schema for "what should I do next" reuses that path exactly
instead of building and maintaining four native tool-calling integrations.
"""

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from app.llm.generate import generate_structured
from app.llm.prompt_loader import render_prompt
from app.llm.router import Tier
from app.voice.tools import MAX_TOOL_CALLS_PER_TURN, TOOL_DEFINITIONS, ToolContext, call_tool

AGENT_PROMPT_VERSION = "v1"


class AgentAction(BaseModel):
    action: Literal["tool_call", "speak"]
    tool: str = ""
    args: dict = {}
    speak: str = ""


@dataclass
class AgentTurnResult:
    spoken_text: str
    tool_calls: list[dict]
    prompt_version: str
    generation_error: str | None


def _tools_block() -> str:
    lines = []
    for t in TOOL_DEFINITIONS:
        args = ", ".join(f"{k}: {v}" for k, v in t["args"].items()) or "(no arguments)"
        lines.append(f"- {t['name']}({args}): {t['description']}")
    return "\n".join(lines)


def _history_block(conversation: list[dict]) -> str:
    return "\n".join(f"{turn['speaker'].capitalize()}: {turn['text']}" for turn in conversation) or "(session just started)"


def _scratchpad_block(tool_calls_this_turn: list[dict]) -> str:
    if not tool_calls_this_turn:
        return "(none yet)"
    lines = []
    for call in tool_calls_this_turn:
        lines.append(f"- Called {call['tool']}({call['args']}) -> {call['result']}")
    return "\n".join(lines)


async def run_agent_turn(
    ctx: ToolContext,
    *,
    system_prompt: str,
    conversation: list[dict],
) -> AgentTurnResult:
    """Runs up to MAX_TOOL_CALLS_PER_TURN tool calls, then returns the spoken
    response. Never raises: a total generation failure degrades to a safe,
    static apology line (section 18's scripted-fallback spirit) rather than
    propagating into the orchestrator."""
    tool_calls_this_turn: list[dict] = []

    for call_index in range(MAX_TOOL_CALLS_PER_TURN + 1):
        force_speak = call_index == MAX_TOOL_CALLS_PER_TURN
        user_prompt = (
            f"CONVERSATION SO FAR:\n{_history_block(conversation)}\n\n"
            f"TOOLS AVAILABLE:\n{_tools_block()}\n\n"
            f"TOOL CALLS MADE THIS TURN SO FAR:\n{_scratchpad_block(tool_calls_this_turn)}\n\n"
            + (
                "You have used all 3 tool calls for this turn. You must respond with action=\"speak\" now."
                if force_speak
                else 'Decide your next action: call one more tool, or speak your response to the patient now.'
            )
            # Small fast-tier models will otherwise re-ask a question they already
            # asked verbatim when the patient's reply changes the subject, which
            # makes the agent look stuck in a loop.
            + (
                "\n\nIMPORTANT: Read the conversation above. Never repeat a question you have "
                "already asked. Respond to what the patient just said and move the conversation "
                "forward."
            )
        )

        result = await generate_structured(
            Tier.FAST,
            AgentAction,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            prompt_version=f"voice_agent_turn.{AGENT_PROMPT_VERSION}",
            temperature=0.3,
            max_tokens=600,
        )

        if result.data is None:
            return AgentTurnResult(
                spoken_text="I'm having trouble right now. Could you say that again in a moment?",
                tool_calls=tool_calls_this_turn,
                prompt_version=result.prompt_version,
                generation_error=result.generation_error,
            )

        action: AgentAction = result.data
        if action.action == "speak" or force_speak:
            spoken = action.speak.strip()
            if spoken:
                return AgentTurnResult(
                    spoken_text=spoken, tool_calls=tool_calls_this_turn, prompt_version=result.prompt_version, generation_error=None
                )
            # action="speak" with nothing to say, or a tool_call on the forced-speak
            # turn. Falling back to a canned apology here strands whatever the tool
            # calls just gathered and reads to the patient as the agent failing --
            # so ask once more for speech only, with tools off the table entirely.
            spoken = await _final_speech(system_prompt, conversation, tool_calls_this_turn)
            return AgentTurnResult(
                spoken_text=spoken, tool_calls=tool_calls_this_turn, prompt_version=result.prompt_version, generation_error=None
            )

        tool_result = await call_tool(ctx, action.tool, action.args)
        tool_calls_this_turn.append({"tool": action.tool, "args": action.args, "result": tool_result})

    # Unreachable given force_speak on the last iteration, but keeps the function
    # total rather than relying on that being airtight forever.
    return AgentTurnResult(
        spoken_text=await _final_speech(system_prompt, conversation, tool_calls_this_turn),
        tool_calls=tool_calls_this_turn,
        prompt_version=AGENT_PROMPT_VERSION,
        generation_error=None,
    )


class _SpeechOnly(BaseModel):
    speak: str


async def _final_speech(system_prompt: str, conversation: list[dict], tool_calls: list[dict]) -> str:
    """Last-resort speech generation with no tool option in the schema, so the
    model cannot answer with another tool call. Only if this also fails do we
    fall back to a static line."""
    result = await generate_structured(
        Tier.FAST,
        _SpeechOnly,
        system_prompt=system_prompt,
        user_prompt=(
            f"CONVERSATION SO FAR:\n{_history_block(conversation)}\n\n"
            f"INFORMATION YOU GATHERED THIS TURN:\n{_scratchpad_block(tool_calls)}\n\n"
            "Reply to the patient now in one or two short spoken sentences. "
            "Do not call any tools. Return JSON with a single field 'speak'."
        ),
        prompt_version=f"voice_agent_final_speech.{AGENT_PROMPT_VERSION}",
        temperature=0.3,
        max_tokens=300,
    )
    if result.data is not None and result.data.speak.strip():
        return result.data.speak.strip()
    return "Sorry, could you say that again?"


def render_system_prompt(*, clinic_name: str, retrieved_chunks: str, patient_context: str, collected_data: str) -> tuple[str, str]:
    return render_prompt(
        "voice_agent_system", AGENT_PROMPT_VERSION,
        clinic_name=clinic_name, retrieved_chunks=retrieved_chunks, patient_context=patient_context, collected_data=collected_data,
    )
