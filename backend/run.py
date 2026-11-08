"""Launch locally, resolving the official W&B CLI credential without copying it."""
import netrc
import os
from pathlib import Path

import uvicorn


def load_wandb_credentials():
    if os.getenv("WANDB_API_KEY"):
        return
    try:
        credentials = netrc.netrc().authenticators("api.wandb.ai")
    except (FileNotFoundError, netrc.NetrcParseError, OSError):
        credentials = None
    if credentials and credentials[2]:
        os.environ["WANDB_API_KEY"] = credentials[2]


def load_elevenlabs_credentials():
    if not os.getenv("ELEVENLABS_API_KEY"):
        config = Path.home() / ".config" / "elevenlabs-mcp" / ".env"
        try:
            for line in config.read_text().splitlines():
                if line.startswith("ELEVENLABS_API_KEY="):
                    os.environ["ELEVENLABS_API_KEY"] = line.split("=", 1)[1].strip().strip("\"'")
                    break
        except OSError:
            pass
    os.environ.setdefault("ELEVENLABS_AGENT_ID", "agent_3801m2dydnpfedfbh6wh80zwj0gc")


if __name__ == "__main__":
    load_wandb_credentials()
    load_elevenlabs_credentials()
    os.environ.setdefault("WANDB_WEAVE_PROJECT", "productmaster-nimbus/pipesense-hackathon")
    os.environ.setdefault("WANDB_PROJECT", "productmaster-nimbus/pipesense-hackathon")
    uvicorn.run("app:app", host="127.0.0.1", port=8000)
