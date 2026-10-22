
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
let supported = false;
let recognitionRunning = false;
let wakeEnabled = false;
let speaking = false;
let mode = "wake";
let restartTimer = null;
let silenceTimer = null;
let questionParts = [];
let lastFinal = "";
let lastWakeAt = 0;

const SILENCE_MS = 1300;
const RESTART_MS = 400;
const WAKE_COOLDOWN_MS = 1800;

// Normalize speech recognition output to make matching easier.
function normalize(text) {
  return text.toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setStatus(text) {
  statusLine.textContent = text;
}

function setPill(text, active = false) {
  connectionStatus.classList.toggle("active", active);
  const node = [...connectionStatus.childNodes]
    .find(n => n.nodeType === Node.TEXT_NODE);

  if (node) node.textContent = " " + text;
  else connectionStatus.appendChild(
    document.createTextNode(" " + text)
  );
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

function resizeInput() {
  input.style.height = "auto";
  input.style.height =
    Math.min(input.scrollHeight, 140) + "px";
}

function clearTimers() {
  clearTimeout(restartTimer);
  clearTimeout(silenceTimer);
  restartTimer = null;
  silenceTimer = null;
}

function startEngine() {
  if (!recognition || !wakeEnabled || speaking || busy ||
      recognitionRunning) return;

  try {
    recognition.start();
  } catch (error) {
    // Safari can briefly remain busy while restarting recognition.
    console.warn("Recognition start:", error);
    scheduleRestart();
  }
}

function scheduleRestart() {
  clearTimeout(restartTimer);

  if (!wakeEnabled || speaking || busy) return;

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startEngine();
  }, RESTART_MS);
}

function stopEngine() {
  clearTimeout(restartTimer);

  if (recognition && recognitionRunning) {
    try {
      recognition.stop();
    } catch (_) {}
  }
}

function startWakeMode() {
  if (!supported) {
    setStatus(
      "Speech recognition is unavailable in this browser. " +
      "You can still type messages."
    );
    return;
  }

  wakeEnabled = true;
  micButton.classList.add("listening");
  micButton.setAttribute("aria-label", "Turn off wake listening");

  setPill("Wake listening", true);
  setStatus(
    'Listening for “Hey, Pmrg2022 AI”, “Hey, Pmrg”, ' +
    '“Hey, PM”, “Hey, twenty-two”, or “Hey, Pmrg”.'
  );

  startEngine();
}

function stopWakeMode() {
  wakeEnabled = false;
  clearTimers();

  if (recognition) {
    try {
      recognition.abort();
    } catch (_) {}
  }

  recognitionRunning = false;
  mode = "wake";
  questionParts = [];
  lastFinal = "";

  micButton.classList.remove("listening");
  micButton.setAttribute("aria-label", "Start wake listening");

  setPill("Ready");
  setStatus("Wake listening is off.");
}

function toggleWakeMode() {
  if (wakeEnabled) stopWakeMode();
  else startWakeMode();
}

// Match both the complete wake phrase and common ASR variants.
// Short phrases are checked only against final results to reduce
// accidental activation while a longer phrase is still being spoken.
function findWake(text, isFinal) {
  const value = normalize(text);
  if (!value) return null;

  const patterns = [
    {
      regex: /\bhey\s+pmrg\s+(?:2022|twenty twenty two|two zero two two)\s+ai\b/,
      short: false
    },
    {
      regex: /\bhey\s+pmrg\s+ai\b/,
      short: false
    },
    {
      regex: /\bpmrg\s+(?:2022|twenty twenty two|two zero two two)\s+ai\b/,
      short: false
    },
    {
      regex: /\bhey\s+pmrg\b/,
      short: false
    },
    {
      regex: /\bpm\b|\btwenty two\b|\bpmrg\b/,
      short: true
    }
  ];

  for (const item of patterns) {
    const match = item.regex.exec(value);

    if (match && (!item.short || isFinal)) {
      return {
        index: match.index,
        end: match.index + match[0].length
      };
    }
  }

  // Some recognizers return the brand as a single joined word.
  const joined = value.replace(/\s/g, "");
  const joinedPhrases = [
    "heypmrg2022ai",
    "heypmrg2022",
    "pmrg2022ai"
  ];

  if (joinedPhrases.some(phrase => joined.includes(phrase))) {
    return { index: 0, end: value.length };
  }

  return null;
}

function removeWakePhrase(text, match) {
  if (!match) return "";

  return (
    text.slice(0, match.index) +
    " " +
    text.slice(match.end)
  ).trim().replace(/^[,.\s!?-]+/, "");
}

function beginQuestion(initialText = "") {
  clearTimeout(silenceTimer);

  mode = "question";
  questionParts = [];
  lastFinal = "";

  if (initialText.trim()) {
    questionParts.push(initialText.trim());
  }

  input.value = questionParts.join(" ");
  resizeInput();

  setPill("Listening", true);
  setStatus("Listening for your question…");

  // Restart the engine in question-capture mode.
  if (recognitionRunning) {
    try {
      recognition.stop();
    } catch (_) {}
  } else {
    startEngine();
  }

  // If the question was spoken in the same sentence as the wake phrase,
  // give the user time to finish it.
  if (input.value.trim()) scheduleQuestionSend();
}

function scheduleQuestionSend() {
  clearTimeout(silenceTimer);

  silenceTimer = setTimeout(() => {
    silenceTimer = null;

    const message = input.value.trim();

    if (!message) {
      setStatus("Still listening for your question…");
      return;
    }

    mode = "wake";
    stopEngine();

    sendMessage(message, true);
  }, SILENCE_MS);
}

function onWakeTranscript(text, isFinal) {
  const match = findWake(text, isFinal);
  if (!match) return;

  const now = Date.now();
  if (now - lastWakeAt < WAKE_COOLDOWN_MS) return;

  lastWakeAt = now;

  const remainder = removeWakePhrase(text, match);
  beginQuestion(remainder);
}

function onQuestionTranscript(text, isFinal) {
  const transcript = text.trim();
  if (!transcript) return;

  if (isFinal) {
    if (transcript !== lastFinal) {
      questionParts.push(transcript);
      lastFinal = transcript;
    }

    input.value = questionParts.join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else {
    // Show partial recognition while the user is speaking.
    input.value = [...questionParts, transcript]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  resizeInput();
  scheduleQuestionSend();
}

function setupRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    supported = false;
    micButton.title = "Speech recognition is unavailable";
    setStatus(
      "Voice recognition isn't supported here. " +
      "Typed chat remains available."
    );
    return;
  }

  supported = true;
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  recognition.onstart = () => {
    recognitionRunning = true;
  };

  recognition.onresult = event => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || "";

      if (mode === "wake") {
        onWakeTranscript(transcript, result.isFinal);
      } else {
        onQuestionTranscript(transcript, result.isFinal);
      }
    }
  };

  recognition.onerror = event => {
    console.warn("Speech recognition error:", event.error);

    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed"
    ) {
      wakeEnabled = false;
      clearTimers();
      micButton.classList.remove("listening");
      micButton.setAttribute("aria-label", "Start wake listening");
      setPill("Permission needed");
      setStatus(
        "Microphone permission was denied. Check Safari website settings."
      );
      return;
    }

    if (event.error === "audio-capture") {
      setStatus("No microphone available. Check your audio settings.");
    }
  };

  recognition.onend = () => {
    recognitionRunning = false;

    if (wakeEnabled && !speaking && !busy) {
      scheduleRestart();
    }
  };
}

function speakAnswer(text, resumeWake = true) {
  if (!text) {
    if (resumeWake && wakeEnabled) scheduleRestart();
    return;
  }

  if (!("speechSynthesis" in window)) {
    setStatus("Answer received, but speech synthesis is unavailable.");
    if (resumeWake && wakeEnabled) scheduleRestart();
    return;
  }

  window.speechSynthesis.cancel();
  speaking = true;
  stopEngine();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;

  utterance.onstart = () => {
    setPill("Speaking", true);
    setStatus("Pmrg2022AI is speaking…");
  };

  utterance.onend = () => {
    speaking = false;

    if (wakeEnabled && resumeWake) {
      setPill("Wake listening", true);
      setStatus("Ready. Say your wake phrase when you need me.");
      scheduleRestart();
    } else {
      setPill("Ready");
      setStatus("Ready.");
    }
  };

  utterance.onerror = () => {
    speaking = false;
    if (wakeEnabled && resumeWake) scheduleRestart();
  };

  window.speechSynthesis.speak(utterance);
}

async function sendMessage(messageOverride, resumeWake = false) {
  if (busy) return;

  const message = (messageOverride ?? input.value).trim();

  if (!message) {
    setStatus("I didn't catch a question. Please try again.");
    if (wakeEnabled) scheduleRestart();
    return;
  }

  addMessage(message, "user");
  input.value = "";
  resizeInput();

  const typingDiv = addMessage("Thinking…", "ai");

  busy = true;
  sendButton.disabled = true;
  input.disabled = true;
  setStatus("Contacting Pmrg2022AI…");

  let reply = "";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: message
      })
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error("The server returned invalid JSON.");
    }

    if (!response.ok) {
      throw new Error(
        data.error || `Server error (${response.status}).`
      );
    }

    if (typeof data.response !== "string" || !data.response.trim()) {
      throw new Error("No valid 'response' field was returned.");
    }

    reply = data.response;
    lastAnswer = reply;
    typingDiv.textContent = reply;
    setStatus("Reply received.");
  } catch (error) {
    console.error(error);
    typingDiv.textContent = "Error: " + error.message;
    typingDiv.classList.add("error");
    setStatus("Request failed. Check your connection.");
  } finally {
    busy = false;
    sendButton.disabled = false;
    input.disabled = false;

    if (resumeWake && wakeEnabled) {
      if (reply) speakAnswer(reply, true);
      else scheduleRestart();
    } else if (reply) {
      speakAnswer(reply, false);
    } else if (wakeEnabled) {
      scheduleRestart();
    }
  }
}

// The microphone button toggles hands-free wake mode.
micButton.addEventListener("click", toggleWakeMode);

document.getElementById("composer").addEventListener("submit", event => {
  event.preventDefault();

  if (mode === "question" && recognitionRunning) {
    try {
      recognition.stop();
    } catch (_) {}
  }

  sendMessage(input.value, wakeEnabled);
});

input.addEventListener("input", resizeInput);

input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage(input.value, wakeEnabled);
  }
});

document.getElementById("repeat-button").addEventListener("click", () => {
  if (lastAnswer) speakAnswer(lastAnswer, wakeEnabled);
  else setStatus("There isn't an answer to repeat yet.");
});

document.getElementById("stop-button").addEventListener("click", () => {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  speaking = false;

  if (wakeEnabled) {
    setStatus("Audio stopped. Resuming wake listening…");
    scheduleRestart();
  } else {
    setStatus("Audio stopped.");
  }
});

document.getElementById("clear-button").addEventListener("click", () => {
  chatContainer.replaceChildren();
  welcome.hidden = false;
  lastAnswer = "";
  setStatus("Conversation cleared.");
});

document.querySelectorAll("[data-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt;
    resizeInput();
    input.focus();
  });
});

setupRecognition();
