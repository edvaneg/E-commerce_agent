// Client for OpenAI Realtime over WebRTC using an ephemeral token from backend
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const assistantEl = document.getElementById("assistant");
const productsEl = document.getElementById("products");
const logEl = document.getElementById("log");
const connectBtn = document.getElementById("connectBtn");
const stopBtn = document.getElementById("stopBtn");
const subtitlesCheckbox = document.getElementById("subtitles");
const audioEl = document.getElementById("assistantAudio");

let pc, dc, micStream;
let transcriptBuf = "";
let assistantBuf = "";
let toolArgBuffers = {}; // tool_call_id -> partial arg string

// Load catalog for initial render (UI only)
let CATALOG = [];
fetch("./products.json").then(r => r.json()).then(data => { CATALOG = data; renderProducts(data); });

function log(...args) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  console.log(...args);
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function renderProducts(items) {
  if (!items || items.length === 0) {
    productsEl.innerHTML = "<div class='small'>No products to show</div>";
    return;
  }
  productsEl.innerHTML = items.map(p => `
    <div class="card">
      <h4>${p.title}</h4>
      <div class="meta">${p.brand} · ${p.category} · ${p.color}</div>
      <div class="meta">$${p.price.toFixed(2)} · ⭐ ${p.rating}</div>
    </div>
  `).join("");
}

// Frontend will forward tool-call args to backend /filter
async function callBackendFilter(args) {
  try {
    const resp = await fetch("http://localhost:8000/filter", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(args)
    });
    if (!resp.ok) {
      const text = await resp.text();
      log("Filter backend error:", text);
      return { error: text };
    }
    return await resp.json();
  } catch (e) {
    log("callBackendFilter error", e);
    return { error: String(e) };
  }
}

async function createEphemeralToken() {
  const resp = await fetch("http://localhost:8000/session", { method: "POST" });
  if (!resp.ok) throw new Error("Failed to create session: " + (await resp.text()));
  const json = await resp.json();
  return json.client_secret;
}

async function start() {
  connectBtn.disabled = true;
  try {
    const token = await createEphemeralToken();

    pc = new RTCPeerConnection();
    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => log("[datachannel] open");
    dc.onmessage = (ev) => handleServerEvent(ev.data);

    pc.onconnectionstatechange = () => {
      statusEl.textContent = pc.connectionState;
      log("[pc] state:", pc.connectionState);
    };

    pc.ontrack = (e) => {
      audioEl.srcObject = new MediaStream([e.track]);
    };

    // Mic capture
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream.getTracks().forEach(t => pc.addTrack(t, micStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send offer to OpenAI Realtime endpoint with ephemeral token
    const base = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    const resp = await fetch(`${base}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/sdp"
      }
    });
    const answer = { type: "answer", sdp: await resp.text() };
    await pc.setRemoteDescription(answer);

    statusEl.textContent = "connected";

    // Kick the assistant with a short instruction
    const iv = setInterval(() => {
      if (dc && dc.readyState === "open") {
        clearInterval(iv);
        sendEvent({ type: "response.create", instructions: "You are an assistant that helps users find products. Suggest example queries like 'show me red shoes under 100'." });
      }
    }, 500);
  } catch (e) {
    log("Error:", e);
    statusEl.textContent = "error";
    connectBtn.disabled = false;
  }
}

function stop() {
  if (dc && dc.readyState === "open") dc.close();
  if (pc) pc.close();
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  statusEl.textContent = "disconnected";
  connectBtn.disabled = false;
}

async function handleServerEvent(data) {
  try {
    const evt = JSON.parse(data);

    switch (evt.type) {
      case "response.output_text.delta": {
        assistantBuf += evt.delta;
        assistantEl.textContent = assistantBuf;
        break;
      }
      case "response.completed": {
        assistantBuf += "\\n";
        break;
      }
      case "transcript.delta": {
        if (!subtitlesCheckbox.checked) break;
        transcriptBuf += evt.delta;
        transcriptEl.textContent = transcriptBuf;
        break;
      }
      case "transcript.completed": {
        transcriptBuf += "\\n";
        break;
      }
      case "response.output_tool_call.arguments.delta": {
        const id = evt.id;
        toolArgBuffers[id] = (toolArgBuffers[id] || "") + evt.delta;
        break;
      }
      case "response.output_tool_call.completed": {
        const callId = evt.id;
        const name = evt.name;
        const argsStr = toolArgBuffers[callId] || "{}";
        delete toolArgBuffers[callId];

        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(argsStr || "{}");
        } catch (err) {
          log("Failed to parse tool args:", err, argsStr);
        }

        // Forward to backend to execute filter
        const backendResp = await callBackendFilter(parsedArgs);
        if (backendResp.error) {
          // Send a function_call_output with error message
          sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ error: String(backendResp.error) })
            }
          });
        } else {
          // Render returned products in UI
          renderProducts(backendResp.results || []);

          // Send the function output back to the model so it can continue
          sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(backendResp.results || [])
            }
          });
        }

        // Ask the assistant to continue
        sendEvent({ type: "response.create" });
        break;
      }
      default:
        // ignore others
        break;
    }
  } catch (err) {
    log("bad server event", err, data);
  }
}

function sendEvent(evt) {
  if (dc && dc.readyState === "open") dc.send(JSON.stringify(evt));
}

connectBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
