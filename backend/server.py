from fastapi import FastAPI, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os, json, requests, pathlib

load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = pathlib.Path(__file__).parent

@app.post("/session")
def create_realtime_session():
    if not OPENAI_API_KEY or not OPENAI_API_KEY.startswith("sk-"):
        return Response(content=json.dumps({"error":"Server missing OPENAI_API_KEY"}), status_code=500, media_type="application/json")

    url = "https://api.openai.com/v1/realtime/sessions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    tools = [{
        "type": "function",
        "name": "filter_products",
        "description": "Filters products in an online store.",
        "parameters": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Product category, e.g. shoes, shirts"
                },
                "color": {
                    "type": "string",
                    "description": "Color of the product"
                },
                "max_price": {
                    "type": "number",
                    "description": "Maximum price in USD"
                }
            },
            "required": ["category"]
        }
    }]

    payload = {
        "model": "gpt-4o-realtime-preview-2024-12-17",
        "voice": "verse",
        "modalities": ["text", "audio"],
        "turn_detection": {"type": "server_vad"},
        "tools": tools,
        "instructions": "You are a voice shopping assistant. When helpful, call filter_products with category (required), optional color and max_price."
    }

    try:
        r = requests.post(url, headers=headers, json=payload, timeout=20)
    except Exception as e:
        return Response(content=json.dumps({"error":str(e)}), status_code=500, media_type="application/json")

    if r.status_code != 200:
        return Response(content=r.text, status_code=r.status_code, media_type="application/json")

    data = r.json()
    client_secret = data.get("client_secret", {}).get("value")
    expires_at = data.get("client_secret", {}).get("expires_at")
    return {"client_secret": client_secret, "expires_at": expires_at}

@app.post("/filter")
async def filter_products(request: Request):
    body = await request.json()
    category = str(body.get("category","")).lower()
    color = (body.get("color") or "").lower()
    max_price = body.get("max_price")

    products_path = BASE_DIR.parent / "frontend" / "products.json"
    if not products_path.exists():
        return {"error": "products.json not found on server"}

    with open(products_path, "r") as f:
        catalog = json.load(f)

    out = [p for p in catalog if p.get("category","").lower() == category]
    if color:
        out = [p for p in out if color in p.get("color","").lower()]
    if isinstance(max_price, (int, float)):
        out = [p for p in out if p.get("price", 0) <= float(max_price)]

    out_limited = out[:12]
    summary = f"{len(out_limited)} {color+' ' if color else ''}{category} found under ${max_price}" if max_price else f"{len(out_limited)} {color+' ' if color else ''}{category} found"
    return {"results": out_limited, "summary": summary}
