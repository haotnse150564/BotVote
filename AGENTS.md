# AGENTS.md

## Project overview

This repository is a minimal Node.js Discord bot built with `discord.js` v14. The app entry point is `index.js`, and it runs as a CommonJS Node.js service.

## Local setup

- Install dependencies with `npm install`.
- Set the environment variable `DISCORD_TOKEN` before starting the bot.
- Start the bot with `node index.js`.
- On Windows PowerShell, use:

  ```powershell
  $env:DISCORD_TOKEN="your_token_here"
  node index.js
  ```

- If the token is missing, the app exits with an explicit error message; do not silently continue without a token.

## Code conventions

- Keep the project lightweight and dependency-minimal.
- Prefer the existing CommonJS (`require`) style instead of introducing ES modules or TypeScript unless the task explicitly requires it.
- Follow the existing `discord.js` v14 patterns already used in `index.js`:
  - create a `Client` with `GatewayIntentBits`
  - listen for `Events.ClientReady`
  - handle `Events.MessageCreate`
  - check `message.author.bot` before processing commands
- Keep business logic simple and near the existing event handlers unless a larger feature clearly requires a new structure.
- Do not hardcode secrets or tokens in source files.

## Commands and validation

- There is no automated test suite configured in `package.json` yet.
- For basic validation, use `node --check index.js` after editing JavaScript.
- Prefer small, focused changes that preserve the current bot behavior and command naming conventions.

## Change guidance

- When adding commands, match the current command style (`!command` patterns already used by the bot).
- When changing runtime behavior, preserve the existing startup and login flow in `index.js`.
- Keep output and user-facing messages concise and Discord-friendly.

## Useful references

- `package.json` defines the runtime package and dependency versions.
- `index.js` is the canonical example for bot setup, event handling, and environment-variable checks.
