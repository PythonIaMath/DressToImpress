## Realtime streaming & signaling

- The FastAPI backend now exposes a Socket.IO server for WebRTC signaling and animation commands.
- Run the combined ASGI app with `uvicorn backend_service.main:socket_app --reload` so both HTTP routes and Socket.IO are available.
- Events:
  - `join_game` / `leave_game`
  - `stream:start` / `stream:stop`
  - `signaling:offer`, `signaling:answer`, `signaling:ice`
  - `animation:command`
- Clients must include the bearer token in the Socket.IO connection so the server can associate sockets with Supabase users.
