import os
from flask import Flask, render_template, request, jsonify, send_file
from flask_socketio import SocketIO, join_room, leave_room, emit

app = Flask(__name__)
app.config['SECRET_KEY'] = 'partyhub-secret-2024'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Room data store
rooms_data = {}


# -----------------------
# FLASK ROUTES
# -----------------------

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/create')
def create():
    return render_template('create.html')


@app.route('/room')
def room():
    return render_template('room.html')


@app.route('/api/room/<room_id>')
def api_check_room(room_id):
    room = rooms_data.get(room_id.upper())
    if room:
        return jsonify({
            "exists": True,
            "mode": room["mode"],
            "viewers": len(room["users"])
        })
    return jsonify({"exists": False}), 404


@app.route('/video/<room_id>')
def serve_video(room_id):
    room = rooms_data.get(room_id.upper())
    if not room or not room.get("local_path"):
        return "Video not found", 404
    path = room["local_path"]
    if not os.path.exists(path):
        return "File not found on server", 404
    return send_file(path, conditional=True)


# -----------------------
# SOCKET EVENTS
# -----------------------

@socketio.on('connect')
def handle_connect():
    print("Connected:", request.sid)


@socketio.on('disconnect')
def handle_disconnect():
    print("Disconnected:", request.sid)

    for room_id in list(rooms_data.keys()):
        room = rooms_data.get(room_id)
        if room and request.sid in room["users"]:
            username = room["users"].pop(request.sid, "Someone")

            # If host leaves, assign next user as host
            if room["host"] == request.sid:
                remaining = list(room["users"].keys())
                room["host"] = remaining[0] if remaining else None
                if room["host"]:
                    emit("host_changed", {}, to=room["host"])

            emit("viewer_count", len(room["users"]), to=room_id)
            emit("chat", {
                "username": "System",
                "text": f"{username} left the room"
            }, to=room_id)
            break


@socketio.on("join")
def handle_join(data):
    room_id = data["room"].upper()
    username = data.get("user", "Anonymous")
    mode = data.get("mode", "watch")

    join_room(room_id)

    if room_id not in rooms_data:
        rooms_data[room_id] = {
            "users": {},
            "host": None,
            "mode": mode,
            "yt_url": data.get("ytUrl", ""),
            "yt_time": 0,
            "yt_playing": False,
            "spotify_uri": data.get("spotifyUri", ""),
            "spotify_pos": 0,
            "spotify_playing": False,
            "pages": data.get("pages", []),
            "current_page": 0,
            "local_path": data.get("localPath", ""),
            "local_time": 0,
            "local_playing": False,
        }
    else:
        # If room exists but has no content yet, and this joiner provided some (e.g. host rejoining)
        r = rooms_data[room_id]
        if not r.get("yt_url") and data.get("ytUrl"): r["yt_url"] = data["ytUrl"]
        if not r.get("spotify_uri") and data.get("spotifyUri"): r["spotify_uri"] = data["spotifyUri"]
        if not r.get("pages") and data.get("pages"): r["pages"] = data["pages"]
        if not r.get("local_path") and data.get("localPath"): r["local_path"] = data["localPath"]

    room = rooms_data[room_id]
    room["users"][request.sid] = username

    # First user = host
    if room["host"] is None:
        room["host"] = request.sid

    is_host = room["host"] == request.sid

    # Send full room state to the new user
    emit("room_state", {
        "mode": room["mode"],
        "is_host": is_host,
        # Watch
        "yt_url": room["yt_url"],
        "yt_time": room["yt_time"],
        "yt_playing": room["yt_playing"],
        # Listen
        "spotify_uri": room["spotify_uri"],
        "spotify_pos": room["spotify_pos"],
        "spotify_playing": room["spotify_playing"],
        # Read
        "pages": room["pages"],
        "current_page": room["current_page"],
        # Local
        "local_path": room["local_path"],
        "local_time": room["local_time"],
        "local_playing": room["local_playing"],
    }, to=request.sid)

    emit("viewer_count", len(room["users"]), to=room_id)
    emit("chat", {
        "username": "System",
        "text": f"{username} joined the room 🎉"
    }, to=room_id)


# -----------------------
# YOUTUBE SYNC
# -----------------------

@socketio.on("yt_play")
def handle_yt_play(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["yt_time"] = data.get("time", 0)
        rooms_data[room_id]["yt_playing"] = True
    emit("yt_play", data.get("time", 0), to=room_id, include_self=False)


@socketio.on("yt_pause")
def handle_yt_pause(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["yt_time"] = data.get("time", 0)
        rooms_data[room_id]["yt_playing"] = False
    emit("yt_pause", data.get("time", 0), to=room_id, include_self=False)


@socketio.on("yt_seek")
def handle_yt_seek(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["yt_time"] = data.get("time", 0)
    emit("yt_seek", data.get("time", 0), to=room_id, include_self=False)


@socketio.on("yt_time_update")
def handle_yt_time(data):
    room_id = data["room"].upper()
    if room_id not in rooms_data:
        return
    
    room = rooms_data[room_id]
    if request.sid == room["host"]:
        # Host updates the server's source of truth
        room["yt_time"] = data.get("time", 0)
    else:
        # Viewers check their time against the server's time
        server_time = room["yt_time"]
        # If viewer is off by more than 2 seconds, force them to sync
        if abs(data.get("time", 0) - server_time) > 2:
            emit("yt_resync", server_time, to=request.sid)


# -----------------------
# SPOTIFY SYNC
# -----------------------

@socketio.on("spotify_play")
def handle_spotify_play(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["spotify_pos"] = data.get("pos", 0)
        rooms_data[room_id]["spotify_playing"] = True
    emit("spotify_play", data.get("pos", 0), to=room_id, include_self=False)


@socketio.on("spotify_pause")
def handle_spotify_pause(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["spotify_pos"] = data.get("pos", 0)
        rooms_data[room_id]["spotify_playing"] = False
    emit("spotify_pause", data.get("pos", 0), to=room_id, include_self=False)


@socketio.on("spotify_seek")
def handle_spotify_seek(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["spotify_pos"] = data.get("pos", 0)
    emit("spotify_seek", data.get("pos", 0), to=room_id, include_self=False)


# -----------------------
# READ MODE SYNC
# -----------------------

@socketio.on("page_change")
def handle_page_change(data):
    room_id = data["room"].upper()
    page = data.get("page", 0)
    if room_id in rooms_data:
        # Only host can change pages
        if rooms_data[room_id]["host"] == request.sid:
            rooms_data[room_id]["current_page"] = page
            emit("page_change", page, to=room_id, include_self=False)


# -----------------------
# LOCAL VIDEO SYNC
# -----------------------

@socketio.on("local_play")
def handle_local_play(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["local_time"] = data.get("time", 0)
        rooms_data[room_id]["local_playing"] = True
    emit("local_play", data.get("time", 0), to=room_id, include_self=False)

@socketio.on("local_pause")
def handle_local_pause(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["local_time"] = data.get("time", 0)
        rooms_data[room_id]["local_playing"] = False
    emit("local_pause", data.get("time", 0), to=room_id, include_self=False)

@socketio.on("local_seek")
def handle_local_seek(data):
    room_id = data["room"].upper()
    if room_id in rooms_data:
        rooms_data[room_id]["local_time"] = data.get("time", 0)
    emit("local_seek", data.get("time", 0), to=room_id, include_self=False)

@socketio.on("local_time_update")
def handle_local_time(data):
    room_id = data["room"].upper()
    if room_id not in rooms_data:
        return
    room = rooms_data[room_id]
    if request.sid == room["host"]:
        room["local_time"] = data.get("time", 0)
    else:
        server_time = room["local_time"]
        if abs(data.get("time", 0) - server_time) > 2:
            emit("local_resync", server_time, to=request.sid)


# -----------------------
# ROOM MANAGEMENT
# -----------------------

@socketio.on("set_content")
def handle_set_content(data):
    room_id = data["room"].upper()
    if room_id not in rooms_data:
        return
    
    room = rooms_data[room_id]
    # Only host can change content
    if room["host"] != request.sid:
        return

    mode = room["mode"]
    if mode == "watch":
        room["yt_url"] = data.get("ytUrl", "")
        room["yt_time"] = 0
        room["yt_playing"] = False
    elif mode == "listen":
        room["spotify_uri"] = data.get("spotifyUri", "")
        room["spotify_pos"] = 0
        room["spotify_playing"] = False
    elif mode == "read":
        room["pages"] = data.get("pages", [])
        room["current_page"] = 0
    elif mode == "local":
        room["local_path"] = data.get("localPath", "")
        room["local_time"] = 0
        room["local_playing"] = False

    emit("content_updated", {
        "yt_url": room.get("yt_url"),
        "spotify_uri": room.get("spotify_uri"),
        "pages": room.get("pages"),
        "local_path": room.get("local_path")
    }, to=room_id)


# -----------------------
# CHAT + REACTIONS
# -----------------------

@socketio.on("chat")
def handle_chat(data):
    emit("chat", data, to=data["room"].upper())


@socketio.on("reaction")
def handle_reaction(data):
    emit("reaction", data, to=data["room"].upper(), include_self=False)


# -----------------------
# RUN
# -----------------------

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, allow_unsafe_werkzeug=True)