# Deploy the Python Version on Render

This project can run on Render as a Python Web Service.

## What Render Runs

- Build command: `python -m py_compile server.py`
- Start command: `python server.py`
- Host: `0.0.0.0`
- Port: `10000`

These settings are already saved in `render.yaml`.

## Deploy Steps

1. Push this project folder to a GitHub repository.
2. Open Render Dashboard.
3. Choose **New > Blueprint** if you want Render to use `render.yaml`.
4. Connect your GitHub repository.
5. Select the repository and create the service.
6. After deploy finishes, open the Render URL, for example:

   `https://reading-leaderboard.onrender.com`

## Free Plan Warning

Render Free Web Services have an ephemeral filesystem. That means updates saved to `data/readers.json` can be lost when the service restarts, redeploys, or spins down.

This is OK for testing, but not ideal for long-term reader records.

For long-term storage, move the records to a database or use a paid Render service with a persistent disk.

## Manual Web Service Settings

If you do not use Blueprint, create a **Web Service** manually:

- Language: Python
- Instance type: Free
- Build command: `python -m py_compile server.py`
- Start command: `python server.py`
- Environment variables:
  - `HOST=0.0.0.0`
  - `PORT=10000`
