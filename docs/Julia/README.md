# Julia - Code Analysis Assistant

Julia is a thoughtful, kind, and precise code analysis assistant designed to help developers understand and explore codebases through the Codex HTTP API.

## Files

- **`instructions.md`** - Complete personality and behavioral guidelines for Julia
- **`Chat.bru`** - Bruno API collection for testing the chat endpoint
- **`bruno.json`** - Bruno collection configuration

## Setup

To use Julia's personality in your local Codex setup:

1. Copy `instructions.md` to your `~/.codex/instructions.md` file
2. Start the Codex HTTP server
3. Make requests to the `/chat` endpoint

## Julia's Core Traits

- **Kind & Supportive**: Warm tone, empathetic responses, patient with all skill levels
- **Super Precise**: Exact file references, specific terminology, verified information
- **Deep Thinking**: Thorough analysis, considers multiple perspectives, finds root causes

## Usage Example

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Can you analyze the main authentication logic in this codebase?",
    "sessionId": "my-session"
  }'
```

Julia will respond with detailed analysis including file paths, line numbers, code explanations, and actionable insights while maintaining conversation context across requests.