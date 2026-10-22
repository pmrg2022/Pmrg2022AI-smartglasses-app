const API_URL = "https://ai-custom-hosting.onrender.com/chat";

const chatContainer = document.getElementById("chat-container");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const micButton = document.getElementById("mic-button");
const welcome = document.getElementById("welcome");
const statusLine = document.getElementById("status-line");
const connectionStatus = document.getElementById("connection-status");

let lastAnswer = "";
let busy = false;
let recognition = null;
let isListening = false;

function setStatus(message) {
  statusLine.textContent = message;
}

function addMessage(text, type) {
  welcome.hidden = true;

  const div = document.createElement("div");
  div.classList.add("message", type);
  div.textContent = text;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  input.disabled = value;
  micButton.disabled = value;
}

async function sendMessage(messageOverride) {
  if (busy) return;

  const message = (messageOverride ?? input.value).trim();
  if (!message) return;

  addMessage(message, "user");
  input.value = "";
  resizeInput();

  const typingDiv = addMessage("Thinking…", "ai");
  setBusy(true);
  setStatus("Contacting Pmrg2022AI…");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The server returned invalid JSON.");
    }

    if (!response.ok) {
      throw new Error(data.error || `Server error (${response.status}).`);
    }

    if (typeof data.response !== "string" || !data.response.trim()) {
      throw new Error("The server response did not contain a valid 'response' string.");
    }

    typingDiv.textContent = data.response;
    lastAnswer = data.response;
    setStatus("Reply received.");
    speakAnswer(lastAnswer);
  } catch (error) {
    console.error("Pmrg2022AI request failed:", error);
    typingDiv.textContent = `Couldn't reach Pmrg2022AI: ${error.message}`;
    typingDiv.classList.add("error");
    setStatus("Request failed. Check your connection and try again.");
  } finally {
    setBusy(false);
    input.focus();
  }
}

// Voice input: uses the browser's Web Speech API where available.
// Safari/iOS support varies; typed chat still works without it.
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    micButton.disabled = true;
    micButton.title = "Voice recognition is not supported in this browser";
    setStatus("Voice input is unavailable here. You can still type messages.");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isListening = true;
    micButton.classList.add("listening");
    micButton.setAttribute("aria-label", "Stop voice input");
    connectionStatus.classList.add("active");
    connectionStatus.lastChild.textContent = " Listening";
    setStatus("Listening… Tap the microphone again to finish.");
  };

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    input.value = transcript;
    resizeInput();
  };

  recognition.onerror = (event) => {
    setStatus(`Voice input error: ${event.error}. You can type your message instead.`);
  };

  recognition.onend = () => {
    isListening = false;
    micButton.classList.remove("listening");
    micButton.setAttribute("aria-label", "Start voice input");
    connectionStatus.classList.remove("active");
    connectionStatus.lastChild.textContent = " Ready";
    if (input.value.trim()) {
      setStatus("Voice captured. Review it, then tap Send.");
    }
  };
}

function toggleListening() {
  if (!recognition || busy) return;

  if (isListening) {
    recognition.stop();
    return;
  }

  try {
    recognition.start();
  } catch (error) {
    console.warn("Could not start recognition:", error);
    setStatus("Could not start the microphone. Try again or type your message.");
  }
}

// Speak answers through the system's selected audio output.
// Connect the six-13 glasses in Bluetooth settings before testing.
function speakAnswer(text) {
  if (!("speechSynthesis" in window) || !text) {
    setStatus("Reply received. Speech playback isn't supported in this browser.");
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.onstart = () => setStatus("Speaking reply…");
  utterance.onend = () => setStatus("Ready for your next question.");
  utterance.onerror = (event) => {
    setStatus(`Speech playback issue: ${event.error || "unknown error"}`);
  };
  window.speechSynthesis.speak(utterance);
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

document.getElementById("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (isListening && recognition) recognition.stop();
  sendMessage();
});

input.addEventListener("input", resizeInput);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

micButton.addEventListener("click", toggleListening);

document.getElementById("repeat-button").addEventListener("click", () => {
  if (lastAnswer) speakAnswer(lastAnswer);
  else setStatus("There isn't an answer to repeat yet.");
});

document.getElementById("stop-button").addEventListener("click", () => {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setStatus("Audio stopped.");
});

document.getElementById("clear-button").addEventListener("click", () => {
  chatContainer.replaceChildren();
  welcome.hidden = false;
  lastAnswer = "";
  setStatus("Conversation cleared.");
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt;
    resizeInput();
    input.focus();
  });
});

setupSpeechRecognition();
