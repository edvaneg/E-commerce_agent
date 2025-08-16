# Voice E‑commerce Agent — Backend-side filter + Real-time Transcript Streaming

This repo implements a real-time voice-powered e-commerce assistant using OpenAI Realtime API (WebRTC).
Key changes in this version:
- **Backend executes `filter_products`** (frontend forwards tool-call arguments to backend; backend returns results).
- **Real-time transcript streaming** displayed in the browser via `transcript.delta` events.

## How it works (high level)
1. Browser requests ephemeral key from backend `/session` (backend calls `POST /v1/realtime/sessions` using your OPENAI_API_KEY).
2. Browser establishes WebRTC with the ephemeral key to OpenAI Realtime. Audio flows to the model; model streams transcripts as `transcript.delta` events over the data channel.
3. When the model issues a function call (`filter_products`) the model streams the arguments to the browser as `response.output_tool_call.arguments.delta` events and eventually `response.output_tool_call.completed`.
4. **Frontend** sends those assembled arguments to the backend `/filter` endpoint.
5. **Backend** runs `filter_products` (against `products.json`) and returns results to the frontend.
6. Frontend sends the function result back to the model via the datachannel `conversation.item.create` (type `function_call_output`) followed by `response.create` so the assistant continues speaking.
   - This keeps the WebRTC/datachannel conversation flow intact while moving product logic to the server.

## Run locally
1. Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# set OPENAI_API_KEY in .env
uvicorn server:app --reload --port 8000
```
2. Frontend
```bash
cd frontend
python -m http.server 5500
# open http://localhost:5500
```

## Endpoints (backend)
- `POST /session` -> returns ephemeral client_secret for Realtime WebRTC
- `POST /filter` -> accepts JSON: `{ "category": "...", "color": "...", "max_price": 100 }` and returns filtered product list from `products.json`

## Notes
- Keep your long-lived OpenAI API key on the server only.
- The frontend still sends the final function_call_output back to the model (as required by Realtime dataflow); the heavy-lifting search/filtering is performed on the backend.
