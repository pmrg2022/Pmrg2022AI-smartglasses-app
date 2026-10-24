console.log("Pmrg2022AI: script started");

window.addEventListener("error", function (event) {
  const status = document.getElementById("status-line");

  if (status) {
    status.textContent =
      "JavaScript error: " + event.message;
  }

  console.error("Pmrg2022AI error:", event.message);
});

window.addEventListener("unhandledrejection", function (event) {
  const status = document.getElementById("status-line");

  if (status) {
    status.textContent =
      "Async error: " + String(event.reason);
  }

  console.error("Pmrg2022AI async error:", event.reason);
});

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
let restartPending = false;
let restartAttempts = 0;
let transcriptPaused = false;

const SILENCE_MS = 1300;
const RESTART_MS = 400;
const WAKE_COOLDOWN_MS = 1800;

const diagnosticLog = [];

let availableVoices = [];
let selectedVoice = null;
let speechWarmupStarted = false;

function loadSpeechVoices() {
  if (!("speechSynthesis" in window)) {
    logDiagnostic("Speech synthesis unavailable.");
    return;
  }

  const synth = window.speechSynthesis;
  availableVoices = synth.getVoices();

  selectedVoice =
    availableVoices.find(voice =>
      voice.lang.toLowerCase() === "en-us"
    ) ||
    availableVoices.find(voice =>
      voice.lang.toLowerCase().startsWith("en-us")
    ) ||
    availableVoices.find(voice =>
      voice.lang.toLowerCase().startsWith("en")
    ) ||
    null;

  logDiagnostic(
    `Voices loaded: ${availableVoices.length}; ` +
    `selected=${selectedVoice ? selectedVoice.name : "default"}`
  );
  if (availableVoices.length > 0 && !speechWarmupStarted) {
    speechWarmupStarted = true;
    logDiagnostic(
      "Voices loaded. Waiting for user interaction to test speech."
    );
  }
}

if ("speechSynthesis" in window) {
  loadSpeechVoices();

  window.speechSynthesis.addEventListener(
    "voiceschanged",
    loadSpeechVoices
  );

  // Safari may populate its voice list after page startup.
  setTimeout(loadSpeechVoices, 500);
  setTimeout(loadSpeechVoices, 1500);
  setTimeout(loadSpeechVoices, 3000);
}



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

function testDelayedSpeech() {
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(
    "This is a delayed speech test."
  );

  utterance.onstart = () => {
    logDiagnostic("DELAY TEST: speech started.");
  };

  utterance.onend = () => {
    logDiagnostic("DELAY TEST: speech ended.");
  };

  utterance.onerror = (event) => {
    logDiagnostic("DELAY TEST ERROR: " + event.error);
  };

  logDiagnostic("DELAY TEST: scheduling speech.");

  setTimeout(() => {
    logDiagnostic("DELAY TEST: calling speak().");
    synth.speak(utterance);
  }, 250);
}

function logDiagnostic(message) {
  const time = new Date().toLocaleTimeString();
  diagnosticLog.unshift(`${time} — ${message}`);
  diagnosticLog.length = Math.min(diagnosticLog.length, 12);

  let panel = document.getElementById("diagnostic-log");

  if (!panel) {
    panel = document.createElement("pre");
    panel.id = "diagnostic-log";
    panel.style.cssText =
      "white-space:pre-wrap;overflow-wrap:anywhere;" +
      "font-size:12px;padding:10px;border-radius:8px;" +
      "background:#202020;color:#ddd;max-height:220px;" +
      "overflow:auto;margin:8px 0;";
    statusLine.insertAdjacentElement("afterend", panel);
  }

  panel.textContent = diagnosticLog.join("\n");
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
  if (!recognition || !wakeEnabled || speaking || busy) return;

  if (recognitionRunning) {
    restartPending = true;
    return;
  }

  restartPending = false;

  try {
    recognition.start();
  } catch (error) {
    logDiagnostic("Start failed: " + error.name);
    restartPending = true;
    scheduleRestart();
  }
}

function scheduleRestart() {
  logDiagnostic("Restart timer fired");
  if (!wakeEnabled || speaking || busy) {
    restartPending = true;
    return;
  }

  restartPending = true;
  clearTimeout(restartTimer);

  const delay = Math.min(500 * (2 ** restartAttempts), 4000);

  restartTimer = setTimeout(() => {
    restartTimer = null;

    if (!wakeEnabled || speaking || busy) return;

    if (recognitionRunning) {
      // Wait for onend to confirm Safari has stopped.
      return;
    }

    restartPending = false;
    startEngine();
  }, delay);
}

function stopEngine() {
  clearTimeout(restartTimer);
  restartTimer = null;

  if (recognition && recognitionRunning) {
    try {
      recognition.stop();
    } catch (error) {
      logDiagnostic("Stop failed: " + error.name);
    }
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
  if (!isFinal) return null;

  const normalized = normalize(text);

  const patterns = [
    /\bhey\s+(?:p\s*m\s*r\s*g|pmrg|prg)(?:\s*(?:2022|twenty\s+twenty\s+two|twenty\s+two|two\s+zero\s+two\s+two|22))?\s*ai\b/,
    /\bhey\s+(?:p\s*m\s*r\s*g|pmrg|prg)\b/,
    /\bhey\s+p\s*\.?\s*m\s*\.?\b/,
    /\bhey\s+(?:twenty\s+two|22|8\s*22|822)\b/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match) {
      return {
        phrase: match[0],
        index: match.index
      };
    }
  }

  return null;
}

function removeWakePhrase(text, match) {
  if (!match) return text.trim();

  const patterns = [
    /^\s*hey[\s,]+(?:p\s*\.?\s*m\s*\.?\s*r\s*\.?\s*g|pmrg|prg)(?:[\s,]*(?:2022|twenty[\s-]+twenty[\s-]+two|twenty[\s-]+two|two[\s-]+zero[\s-]+two[\s-]+two|22))?(?:[\s,]*ai)?\b[\s,.:;-]*/i,

    /^\s*hey[\s,]+p\s*\.?\s*m\s*\.?\b[\s,.:;-]*/i,

    /^\s*hey[\s,]+(?:twenty[\s-]+two|22|8\s*22|822)\b[\s,.:;-]*/i
  ];

  for (const pattern of patterns) {
    const cleaned = text.replace(pattern, "").trim();

    if (cleaned !== text.trim()) {
      return cleaned;
    }
  }

  return text.trim();
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
  setStatus("Wake phrase detected. Listening for your question…");

  // Keep the current recognition session running.
  // Do not stop and restart it here.

  if (input.value.trim()) {
    scheduleQuestionSend();
  }
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

    sendMessage(message, true);
  }, SILENCE_MS);
}

function onWakeTranscript(text, isFinal) {
  const wake = findWake(text, isFinal);
  if (!wake) return;

  const now = Date.now();
  if (now - lastWakeAt < WAKE_COOLDOWN_MS) return;
  lastWakeAt = now;

  const question = removeWakePhrase(text, wake);
  beginQuestion(question);
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

    resizeInput();

    // Only submit after a final result, never an interim fragment.
    if (input.value.trim()) {
      scheduleQuestionSend();
    }
  } else {
    input.value = [...questionParts, transcript]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    resizeInput();
  }
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
    restartAttempts = 0;
    logDiagnostic("Recognition started");
    setStatus(
      mode === "wake"
        ? 'Listening for "Hey, Pmrg"…'
        : "Listening for your question…"
    );
  };


  
  recognition.onerror = event => {
    const message = "Speech error: " + event.error;

    console.error(message, event);
    logDiagnostic("ERROR: " + event.error);
    setStatus(message);

    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed"
    ) {
      wakeEnabled = false;
      clearTimers();
      micButton.classList.remove("listening");
      micButton.setAttribute("aria-label", "Start wake listening");
      setPill("Permission needed");
      setStatus(message + ". Check Safari permissions.");
    }
  };


  
  recognition.onresult = event => {
    if (transcriptPaused || speaking || busy) {

      logDiagnostic("Transcript ignored: AI is busy or speaking.");

      return;

    }

    const startingMode = mode;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      logDiagnostic(
        "Heard: " + event.results[i][0].transcript +
        " | final=" + event.results[i].isFinal
      );
      const result = event.results[i];
      const transcript = result[0]?.transcript || "";

      if (!transcript.trim()) continue;

      console.log("Recognized speech:", transcript, {
        final: result.isFinal,
        mode: startingMode
      });

      if (startingMode === "wake") {
        onWakeTranscript(transcript, result.isFinal);

        // A wake phrase changed the mode. Do not treat other
        // results in this same event as the user's question.
        if (mode !== "wake") return;
      } else {
        onQuestionTranscript(transcript, result.isFinal);
      }
    }
  };


  
  
  recognition.onend = () => {
    recognitionRunning = false;
    logDiagnostic("Recognition ended");
    logDiagnostic(
      `Restart check: wakeEnabled=${wakeEnabled}, ` +
      `speaking=${speaking}, busy=${busy}, mode=${mode}`
    );

    if (!wakeEnabled) return;

    if (speaking || busy) {
      restartPending = true;
      return;
    }

    if (restartPending || mode === "wake") {
      restartAttempts = Math.min(restartAttempts + 1, 3);
      scheduleRestart();
    }
  };



}

function speakAnswer(text, resumeWake = true) {
  logDiagnostic("speakAnswer called; text length=" + text.length);
  logDiagnostic("speakAnswer called.");
  logDiagnostic("Speech synthesis speaking: " +
    window.speechSynthesis.speaking);
  logDiagnostic("Speech synthesis pending: " +
    window.speechSynthesis.pending);
  
  if (!text) {
    if (resumeWake && wakeEnabled) scheduleRestart();
    return;
  }

  if (!("speechSynthesis" in window)) {
    setStatus("Answer received, but speech synthesis is unavailable.");
    if (resumeWake && wakeEnabled) scheduleRestart();
    return;
  }

  logDiagnostic("Preparing speech without cancelling.");
  const synth = window.speechSynthesis;

  speaking = true;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;

  // Refresh the voice list in case Safari loaded voices late.
  if (availableVoices.length === 0) {
    loadSpeechVoices();
  }

  if (selectedVoice) {
    utterance.voice = selectedVoice;
    logDiagnostic("Selected voice: " + selectedVoice.name);
  } else {
    logDiagnostic("No English voice ready; using system default.");
  }

  utterance.onstart = () => {
    logDiagnostic("Speech started successfully.");
    setPill("Speaking", true);
    setStatus("Pmrg2022AI is speaking…");
  };

  utterance.onend = () => {
    logDiagnostic("Speech finished.");
    speaking = false;
    transcriptPaused = false;

    if (wakeEnabled && resumeWake) {
      mode = "wake";
      setPill("Wake listening", true);
      setStatus('Ready. Say "Hey, Pmrg" to talk.');
      scheduleRestart();
    } else {
      setPill("Ready");
      setStatus("Ready.");
    }
  };

  utterance.onerror = event => {
    logDiagnostic("Speech ERROR: " + event.error);
    speaking = false;
    transcriptPaused = false;

    if (wakeEnabled && resumeWake) {
      scheduleRestart();
    }
  };

  logDiagnostic(
    `Before speak(): speaking=${window.speechSynthesis.speaking}, ` +
    `pending=${window.speechSynthesis.pending}, ` +
    `voices=${window.speechSynthesis.getVoices().length}`
  );
  let speechStarted = false;
  let speechRetried = false;

  utterance.onstart = () => {
    speechStarted = true;
    logDiagnostic("Speech started successfully.");
    setPill("Speaking", true);
    setStatus("Pmrg2022AI is speaking…");
  };

  utterance.onend = () => {
    logDiagnostic("Speech finished.");
    speaking = false;
    transcriptPaused = false;

    if (wakeEnabled && resumeWake) {
      mode = "wake";
      setPill("Wake listening", true);
      setStatus('Ready. Say "Hey, Pmrg" to talk.');
      scheduleRestart();
    } else {
      setPill("Ready");
      setStatus("Ready.");
    }
  };

  utterance.onerror = event => {
    logDiagnostic("Speech ERROR: " + event.error);
    speaking = false;
    transcriptPaused = false;

    if (wakeEnabled && resumeWake) {
      scheduleRestart();
    }
  };

  function queueSpeech() {
    logDiagnostic("Cancelling previous speech before submission.");

    window.speechSynthesis.cancel();

    logDiagnostic("Submitting utterance to speech engine.");
    window.speechSynthesis.speak(utterance);
  }
  setTimeout(() => {
    queueSpeech();

    setTimeout(() => {
      if (
        !speechStarted &&
        !speechRetried &&
        !window.speechSynthesis.speaking &&
        !window.speechSynthesis.pending
      ) {
        speechRetried = true;
        logDiagnostic("Speech did not start; retrying once.");
        queueSpeech();
      }
    }, 1500);
  }, 250);
  setTimeout(() => {
    logDiagnostic(
      `After 2s: speaking=${window.speechSynthesis.speaking}, ` +
      `pending=${window.speechSynthesis.pending}`
    );
  }, 2000);
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
  transcriptPaused = true;

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

    logDiagnostic(
      `Playback decision: reply=${!!reply}, ` +
      `resumeWake=${resumeWake}, wakeEnabled=${wakeEnabled}`
    );

    if (resumeWake && wakeEnabled) {
      if (reply) {
        logDiagnostic("Calling speakAnswer for voice response.");
        speakAnswer(reply, true);
      } else {
        logDiagnostic("No reply; scheduling wake restart.");
        scheduleRestart();
      }
    } else if (reply) {
      logDiagnostic("Calling speakAnswer for regular response.");
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

function repeatLastAnswer() {
  if (!lastAnswer) {
    setStatus("There isn't an answer to repeat yet.");
    return;
  }

  speakAnswer(lastAnswer, wakeEnabled);
}

function resetSpeechEngine() {
  if (!("speechSynthesis" in window)) return;

  const synth = window.speechSynthesis;

  synth.cancel();

  logDiagnostic("Speech engine reset.");

  // Give Safari a moment to process cancellation before
  // submitting a fresh utterance.
  setTimeout(() => {
    const test = new SpeechSynthesisUtterance(
      "Hello, I am ready to talk."
    );

    test.lang = "en-US";

    test.onstart = () => {
      logDiagnostic("Warm-up speech started.");
    };

    test.onend = () => {
      logDiagnostic("Warm-up speech finished.");
    };

    test.onerror = event => {
      logDiagnostic("Warm-up speech error: " + event.error);
    };

    synth.speak(test);
    logDiagnostic("Warm-up utterance submitted.");
  }, 250);
}

document.getElementById("repeat-button").addEventListener(
  "click",
  repeatLastAnswer
);

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

document.getElementById("repeat-button").addEventListener(
  "dblclick",
  () => {
    const test = new SpeechSynthesisUtterance(
      "Hello. This is a speech playback test."
    );

    test.onstart = () => {
      logDiagnostic("TEST speech started");
    };

    test.onend = () => {
      logDiagnostic("TEST speech ended");
    };

    test.onerror = event => {
      logDiagnostic("TEST speech error: " + event.error);
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(test);

    logDiagnostic("TEST speech queued");
  }
);

setupRecognition();
