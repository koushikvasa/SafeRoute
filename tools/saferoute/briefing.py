"""Plain-language evacuation briefing per timestep from W&B Inference. Optional; failures return None."""

import os

import requests

BASE = "https://api.inference.wandb.ai/v1"
MODEL = "meta-llama/Llama-3.1-8B-Instruct"


def write(scenario, minute, facts):
    if not os.environ.get("WANDB_API_KEY"):
        return None
    prompt = (
        f"You are an emergency dispatcher in a {scenario} evacuation drill in Midtown Manhattan, T+{minute} minutes. "
        "Write a two-sentence briefing for a driver on the trip below. "
        "Use only these facts from street cameras; do not invent places or numbers.\n" + facts
    )
    response = requests.post(
        f"{BASE}/chat/completions",
        headers={
            "Authorization": f"Bearer {os.environ['WANDB_API_KEY']}",
            "OpenAI-Project": f"{os.environ['WANDB_TEAM']}/{os.environ['WANDB_PROJECT']}",
        },
        json={"model": MODEL, "max_tokens": 120, "temperature": 0.2,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=20,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"].strip()
