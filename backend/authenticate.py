"""Interactive W&B login. Paste secrets only into this hidden terminal prompt."""
from getpass import getpass

import wandb


def main():
    print("Use https://wandb.ai/authorize in Chromium to obtain your W&B API key.")
    print("The key is stored by W&B outside this repository; input is hidden.")
    key = getpass("W&B API key: ").strip()
    if not key:
        raise SystemExit("No key supplied; nothing changed.")
    try:
        wandb.login(key=key, host="https://api.wandb.ai", verify=True)
    except Exception:
        raise SystemExit("Authentication failed. Check the key and network; no secret was printed.") from None
    finally:
        key = None
    print("W&B authentication verified. You can close this terminal.")


if __name__ == "__main__":
    main()
