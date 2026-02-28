function createRoom() {
  const roomName = document.getElementById("roomName").value;
  const videoUrl = document.getElementById("videoUrl").value;

  if (!roomName) {
    alert("Enter room name");
    return;
  }

  const roomId = Math.random().toString(36).substring(2, 8);

  const roomData = {
    name: roomName,
    videoUrl: videoUrl
  };

  localStorage.setItem("room_" + roomId, JSON.stringify(roomData));
  window.location.href = "room.html?id=" + roomId;
}

function getRoomData() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  if (!id) return;

  const data = JSON.parse(localStorage.getItem("room_" + id));

  if (data) {
    document.getElementById("roomTitle").innerText = data.name;
    if (data.videoUrl) {
      document.getElementById("videoPlayer").src = data.videoUrl;
    }
  }
}

function togglePlay() {
  const video = document.getElementById("videoPlayer");
  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
}

function sendMessage() {
  const input = document.getElementById("messageInput");
  const chat = document.getElementById("chatBox");

  if (!input.value) return;

  chat.innerHTML += `
    <div class="message">
      <span class="username">You:</span> ${input.value}
    </div>
  `;

  input.value = "";
}

function copyLink() {
  navigator.clipboard.writeText(window.location.href);
  alert("Link copied!");
}

getRoomData();