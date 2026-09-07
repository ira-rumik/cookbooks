/*!
 * silk-widget.js — a drop-in "Call AI" bubble for Rumik Silk voice agents.
 *
 * Usage (one tag, no build step):
 *
 *   <script src="https://your-cdn.example/silk-widget.js"
 *           data-token-url="/api/token"
 *           data-label="Talk to our AI"
 *           data-color="#c2410c"
 *           data-position="bottom-right"></script>
 *
 * data-token-url must POST to a backend that calls Silk's /v1/webcall with
 * your API key and returns { token, host, roomName, callId } — see
 * ../shared/token-server-node. The API key never reaches this file.
 *
 * Transport: WebRTC via livekit-client (loaded from a CDN on first click).
 * Public API: window.SilkWidget.start() / .stop() / .on(event, fn) / .state
 */
(function () {
  "use strict";
  if (window.SilkWidget) return;

  /* ------------------------------------------------------------------ config */
  var script = document.currentScript;
  var ds = (script && script.dataset) || {};
  var cfg = {
    tokenUrl: ds.tokenUrl || "/api/token",
    label: ds.label || "Talk to our AI",
    color: ds.color || "#c2410c",
    position: ds.position === "bottom-left" ? "bottom-left" : "bottom-right",
    livekitSrc: ds.livekitSrc || "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js",
    agentId: ds.agentId || null, // optional; your token server decides whether to honour it
  };

  var AGENT_STATE_ATTR = "lk.agent.state"; // set by LiveKit-aware agents: listening|thinking|speaking

  var LABELS = {
    idle: cfg.label,
    mic: "Allow microphone…",
    connecting: "Connecting…",
    listening: "Listening",
    thinking: "Thinking",
    speaking: "Speaking",
    interrupting: "Go ahead",
    error: "Error",
  };

  var FRIENDLY = {
    agent_not_deployed: "The agent has not been deployed yet.",
    insufficient_balance: "This agent is out of credit.",
    concurrency_limit_exceeded: "All lines are busy — try again in a moment.",
  };

  /* --------------------------------------------------------------- styles */
  var css = [
    ".silk-w{position:fixed;z-index:2147483000;bottom:20px;" + (cfg.position === "bottom-left" ? "left:20px" : "right:20px") + ";font:14px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1917}",
    ".silk-w *{box-sizing:border-box}",
    ".silk-btn{display:flex;align-items:center;gap:10px;height:56px;padding:0 20px 0 16px;border:0;border-radius:999px;background:" + cfg.color + ";color:#fff;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.18);transition:transform .15s}",
    ".silk-btn:hover{transform:translateY(-1px)}",
    ".silk-btn svg{width:22px;height:22px;flex:none}",
    ".silk-ring{position:relative;width:24px;height:24px;flex:none}",
    ".silk-ring::before,.silk-ring::after{content:'';position:absolute;inset:0;border-radius:50%;background:currentColor;opacity:.35}",
    ".silk-ring::after{animation:silk-pulse 1.2s ease-out infinite}",
    "@keyframes silk-pulse{0%{transform:scale(.6);opacity:.6}100%{transform:scale(1.8);opacity:0}}",
    ".silk-w[data-state=idle] .silk-ring,.silk-w[data-state=error] .silk-ring{display:none}",
    ".silk-w[data-state=idle] .silk-mic,.silk-w[data-state=error] .silk-mic{display:block}",
    ".silk-mic{display:none}",
    ".silk-w[data-state=listening] .silk-ring{color:#e7e5e4}",
    ".silk-w[data-state=thinking] .silk-ring{color:#fbbf24}",
    ".silk-w[data-state=speaking] .silk-ring{color:#f87171}",    /* red: agent talking   */
    ".silk-w[data-state=interrupting] .silk-ring{color:#4ade80}",/* green: you cut in    */
    ".silk-w[data-state=connecting] .silk-ring::after,.silk-w[data-state=mic] .silk-ring::after{animation-duration:.6s}",
    ".silk-hang{display:none;margin-left:6px;width:28px;height:28px;border:0;border-radius:50%;background:rgba(255,255,255,.22);color:#fff;cursor:pointer;font-size:16px;line-height:28px;text-align:center}",
    ".silk-w[data-live=true] .silk-hang{display:inline-block}",
    ".silk-err{margin-top:8px;max-width:280px;padding:8px 12px;border-radius:10px;background:#fee2e2;color:#7f1d1d;font-size:13px;display:none}",
    ".silk-w[data-state=error] .silk-err{display:block}",
    ".silk-w[data-audio-blocked=true] .silk-btn{outline:3px solid #fbbf24}",
  ].join("\n");

  /* ---------------------------------------------------------------- DOM */
  var root, btn, label, errBox, audioEl;

  function mount() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    root = document.createElement("div");
    root.className = "silk-w";
    root.setAttribute("data-state", "idle");
    root.innerHTML =
      '<button class="silk-btn" type="button" aria-live="polite">' +
      '<svg class="silk-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
      '<span class="silk-ring"></span>' +
      '<span class="silk-label"></span>' +
      '<span class="silk-hang" role="button" aria-label="Hang up" title="Hang up">&#x2715;</span>' +
      "</button>" +
      '<div class="silk-err" role="alert"></div>';
    document.body.appendChild(root);

    btn = root.querySelector(".silk-btn");
    label = root.querySelector(".silk-label");
    errBox = root.querySelector(".silk-err");

    // Hidden sink for the agent's audio track. autoplay + playsinline keep
    // iOS Safari happy; display:none does not stop audio.
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "");
    audioEl.style.display = "none";
    root.appendChild(audioEl);

    btn.addEventListener("click", function (e) {
      if (e.target.closest(".silk-hang")) return stop();
      if (room && !room.canPlaybackAudio) return room.startAudio(); // autoplay was blocked
      if (state === "idle" || state === "error") start();
      else stop();
    });

    setState("idle");
  }

  /* ---------------------------------------------------------------- state */
  var state = "idle";
  var listeners = {};
  var room = null;
  var agentAttrState = null; // from lk.agent.state, if the agent publishes it
  var agentSpeaking = false;
  var userSpeaking = false;

  function emit(ev, data) {
    (listeners[ev] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { console.error("[silk-widget]", e); }
    });
  }

  function setState(next, message) {
    state = next;
    root.setAttribute("data-state", next);
    root.setAttribute("data-live", String(!!room));
    label.textContent = LABELS[next] || next;
    if (next === "error") errBox.textContent = message || "Something went wrong.";
    emit("state", next);
  }

  // Combine the attribute (authoritative when present) with speaker activity.
  function recompute() {
    if (!room) return;
    var s = agentAttrState || (agentSpeaking ? "speaking" : "listening");
    if (s === "speaking" && userSpeaking) s = "interrupting"; // barge-in
    if (s === "initializing") s = "connecting";
    setState(s);
  }

  /* ----------------------------------------------------------- livekit */
  function loadLivekit() {
    return new Promise(function (resolve, reject) {
      if (window.LivekitClient) return resolve(window.LivekitClient);
      var s = document.createElement("script");
      s.src = cfg.livekitSrc;
      s.async = true;
      s.onload = function () { resolve(window.LivekitClient); };
      s.onerror = function () { reject(new Error("could not load livekit-client from " + cfg.livekitSrc)); };
      document.head.appendChild(s);
    });
  }

  function requestMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("This browser cannot capture audio (needs HTTPS or localhost)."));
    }
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); }); // LiveKit opens its own track
    }, function (err) {
      if (err && err.name === "NotAllowedError") throw new Error("Microphone blocked — allow it in the address bar and try again.");
      if (err && err.name === "NotFoundError") throw new Error("No microphone found.");
      throw err;
    });
  }

  function fetchCredentials() {
    return fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg.agentId ? { agentId: cfg.agentId } : {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(FRIENDLY[body.code] || (res.status + " " + (body.code || "") + ": " + (body.error || "token request failed")));
        if (!body.token || !body.host) throw new Error("token endpoint did not return { token, host }");
        return body; // { token, host, roomName, callId }
      });
    });
  }

  function start() {
    if (room) return Promise.resolve();
    agentAttrState = null; agentSpeaking = false; userSpeaking = false;

    setState("mic");
    return requestMicrophone()
      .then(function () { setState("connecting"); return Promise.all([loadLivekit(), fetchCredentials()]); })
      .then(function (r) {
        var LK = r[0], call = r[1];
        var Room = LK.Room, RoomEvent = LK.RoomEvent, Track = LK.Track;

        room = new Room({
          // audio only; keep the defaults for echo cancellation / noise suppression
          audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });

        room
          .on(RoomEvent.TrackSubscribed, function (track) {
            if (track.kind === Track.Kind.Audio) track.attach(audioEl); // agent's voice → hidden <audio>
          })
          .on(RoomEvent.ActiveSpeakersChanged, function (speakers) {
            agentSpeaking = speakers.some(function (p) { return !p.isLocal; });
            userSpeaking = speakers.some(function (p) { return p.isLocal; });
            recompute();
          })
          .on(RoomEvent.ParticipantAttributesChanged, function (changed, participant) {
            if (!participant.isLocal && changed[AGENT_STATE_ATTR]) {
              agentAttrState = changed[AGENT_STATE_ATTR];
              recompute();
            }
          })
          .on(RoomEvent.AudioPlaybackStatusChanged, function () {
            root.setAttribute("data-audio-blocked", String(!room.canPlaybackAudio));
          })
          .on(RoomEvent.Disconnected, function (reason) {
            room = null;
            setState("idle");
            emit("disconnected", reason);
          });

        return room.connect(call.host, call.token).then(function () {
          // pick up an agent that was already in the room with a state attribute
          room.remoteParticipants.forEach(function (p) {
            if (p.attributes && p.attributes[AGENT_STATE_ATTR]) agentAttrState = p.attributes[AGENT_STATE_ATTR];
          });
          return room.localParticipant.setMicrophoneEnabled(true);
        }).then(function () {
          recompute();
          emit("connected", call);
        });
      })
      .catch(function (err) {
        console.error("[silk-widget]", err);
        if (room) { try { room.disconnect(); } catch (_) {} room = null; }
        setState("error", err && err.message);
        emit("error", err);
      });
  }

  function stop() {
    if (!room) { setState("idle"); return Promise.resolve(); }
    var r = room; room = null;
    return r.disconnect().then(function () { setState("idle"); });
  }

  /* ---------------------------------------------------------------- boot */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.SilkWidget = {
    start: start,
    stop: stop,
    on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    get state() { return state; },
    get room() { return room; },
  };
})();
