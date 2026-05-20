import os
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Response, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn
import asyncio

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("WarpDropServer")

app = FastAPI()

# HTTP Piped Relay Manager for fallback transfers
class HTTPRelayManager:
    def __init__(self):
        self.transfers = {}
        self.lock = asyncio.Lock()

    async def get_or_create(self, room_id: str):
        async with self.lock:
            if room_id not in self.transfers:
                self.transfers[room_id] = {
                    "chunk": None,
                    "uploaded": asyncio.Event(),
                    "downloaded": asyncio.Event(),
                    "active": True
                }
            return self.transfers[room_id]

    async def cleanup(self, room_id: str):
        async with self.lock:
            if room_id in self.transfers:
                # Signal any waiting events to prevent deadlocks
                self.transfers[room_id]["uploaded"].set()
                self.transfers[room_id]["downloaded"].set()
                del self.transfers[room_id]
                logger.info(f"Cleaned up HTTP relay for room '{room_id}'")

relay_manager = HTTPRelayManager()

@app.post("/relay/upload/{room_id}")
async def relay_upload(room_id: str, file: UploadFile = File(...)):
    relay = await relay_manager.get_or_create(room_id)
    content = await file.read()
    
    relay["chunk"] = content
    relay["uploaded"].set()
    
    try:
        await asyncio.wait_for(relay["downloaded"].wait(), timeout=15.0)
    except asyncio.TimeoutError:
        relay["uploaded"].clear()
        raise HTTPException(status_code=408, detail="Receiver download timeout")
    
    relay["downloaded"].clear()
    return {"status": "ok"}

@app.get("/relay/download/{room_id}")
async def relay_download(room_id: str):
    relay = await relay_manager.get_or_create(room_id)
    
    try:
        await asyncio.wait_for(relay["uploaded"].wait(), timeout=15.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="Sender upload timeout")
        
    relay["uploaded"].clear()
    content = relay["chunk"]
    relay["chunk"] = None
    
    relay["downloaded"].set()
    return Response(content=content, media_type="application/octet-stream")

@app.post("/relay/cleanup/{room_id}")
async def relay_cleanup(room_id: str):
    await relay_manager.cleanup(room_id)
    return {"status": "cleaned"}


# Store active rooms and their clients
# Format: { room_id: set(WebSocket) }
rooms = {}

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    
    # Initialize room if it doesn't exist
    if room_id not in rooms:
        rooms[room_id] = set()
        
    # WarpDrop rooms are strictly peer-to-peer (max 2 participants)
    if len(rooms[room_id]) >= 2:
        logger.warning(f"Room {room_id} is full. Rejecting connection.")
        await websocket.close(code=4001, reason="Room is full. WarpDrop only supports 1-to-1 P2P transfers.")
        return
        
    rooms[room_id].add(websocket)
    peer_count = len(rooms[room_id])
    logger.info(f"Client joined room '{room_id}'. Peers in room: {peer_count}")

    # Notify existing peer that a new peer has joined
    if peer_count == 2:
        for client in rooms[room_id]:
            try:
                await client.send_json({"type": "peer-joined"})
            except Exception as e:
                logger.error(f"Error sending peer-joined notification: {e}")

    try:
        while True:
            # Receive message (SDP offers, SDP answers, ICE candidates)
            message = await websocket.receive_text()
            
            # Broadcast the signal to the other peer in the room
            if room_id in rooms:
                for client in rooms[room_id]:
                    if client != websocket:
                        await client.send_text(message)
                        
    except WebSocketDisconnect:
        logger.info(f"Client disconnected from room '{room_id}'")
    except Exception as e:
        logger.error(f"Error handling socket data for room '{room_id}': {e}")
    finally:
        # Clean up client from room
        if room_id in rooms:
            if websocket in rooms[room_id]:
                rooms[room_id].remove(websocket)
                
            # If there's still a peer in the room, notify them the other left
            if len(rooms[room_id]) > 0:
                for client in rooms[room_id]:
                    try:
                        await client.send_json({"type": "peer-left"})
                    except Exception as e:
                        logger.error(f"Error sending peer-left notification: {e}")
            else:
                # If room is empty, delete it
                del rooms[room_id]
                logger.info(f"Room '{room_id}' is empty and has been deleted.")

# Mount the static files
# We can't mount "." directly as StaticFiles easily because it can override other endpoints
# Let's serve specific files or put index.html, style.css, app.js at the root
@app.get("/")
async def get_index():
    return FileResponse("index.html")

@app.get("/style.css")
async def get_style():
    return FileResponse("style.css")

@app.get("/app.js")
async def get_app_js():
    return FileResponse("app.js", headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


if __name__ == "__main__":
    # Get port from environment (e.g. for Render/Railway deployment) or default to 8000
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting WarpDrop Server on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
