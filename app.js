(function () {
  "use strict";

  const STORE_KEY = "chronos-ai-archive-v1";
  const PLACEHOLDER_TITLE = "Untitled memory";
  const PLACEHOLDER_SOURCE = "Source not specified";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let archiveLoadError = "";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const formatTime = (seconds) => {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "—";
    const whole = Math.floor(Number(seconds));
    const minutes = Math.floor((whole % 3600) / 60);
    const remainder = whole % 60;
    return whole >= 3600
      ? `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  };
  const validRecords = (value) => Array.isArray(value) && value.every((record) =>
    record && typeof record.id === "string" && typeof record.title === "string" &&
    typeof record.source === "string" && typeof record.speaker === "string" &&
    typeof record.place === "string" && typeof record.date === "string" &&
    typeof record.language === "string" && typeof record.description === "string" &&
    Array.isArray(record.topics) && record.topics.every((topic) => typeof topic === "string") &&
    Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string") &&
    Array.isArray(record.segments) &&
    record.segments.every((segment) => segment && Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) && segment.start >= 0 && segment.end >= segment.start &&
      typeof segment.text === "string")
  );
  const readArchive = () => {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (!saved) return clone(window.CHRONOS_DEMO);
      let parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        parsed = parsed.map((record) => record && typeof record === "object"
          ? { ...record, tags: Array.isArray(record.tags) ? record.tags : [] }
          : record);
      }
      if (!validRecords(parsed)) throw new Error("The saved archive has an invalid format.");
      return parsed;
    } catch (error) {
      console.error("Could not load the local archive:", error);
      archiveLoadError = `Could not read the saved archive: ${error.message || "browser storage is unavailable."} Showing the fictional demo archive instead.`;
      return clone(window.CHRONOS_DEMO);
    }
  };

  let records = readArchive();
  let activeId = null;
  let activeMediaUrl = null;
  const audioMediaByRecord = new Map();
  let audioContext = null;
  let analyser = null;
  let mediaSource = null;
  let videoUrl = null;
  let pendingDeleteId = null;
  let toastTimer = 0;
  let graphAnimationFrame = 0;
  let waveAnimationFrame = 0;
  const $ = (selector) => document.querySelector(selector);
  const audio = $("#audio-player");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function showToast(message, isError) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.style.borderColor = isError ? "rgba(255,132,132,.55)" : "";
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3600);
  }

  function saveArchive() {
    try {
      if (!validRecords(records)) throw new Error("Some archive fields or timestamps are invalid.");
      localStorage.setItem(STORE_KEY, JSON.stringify(records));
      renderStats();
      return true;
    } catch (error) {
      console.error("Could not save the local archive:", error);
      showToast(`Could not save archive: ${error.message || "browser storage is unavailable."}`, true);
      return false;
    }
  }

  function activeRecord() {
    return records.find((record) => record.id === activeId) || null;
  }

  function renderStats() {
    $("#stat-records").textContent = String(records.length);
    $("#stat-voices").textContent = String(new Set(records.map((record) => record.speaker).filter(Boolean)).size);
    $("#stat-places").textContent = String(new Set(records.map((record) => record.place).filter(Boolean)).size);
    $("#stat-moments").textContent = String(records.reduce((sum, record) => sum + record.segments.length, 0));
    $("#record-count").textContent = `${records.length} RECORD${records.length === 1 ? "" : "S"}`;
  }

  function renderArchiveList() {
    $("#record-list").innerHTML = records.length ? records.map((record) => {
      const segCount = (record.segments || []).length;
      const speaker = record.speaker || "Unknown speaker";
      const date = record.date || "Date unknown";
      const place = record.place ? ` · 📍 ${escapeHtml(record.place)}` : "";
      return `
      <div class="record-card ${record.id === activeId ? "active" : ""}" data-record-id="${escapeHtml(record.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(record.title || "Untitled memory")}">
        <span class="record-glyph" aria-hidden="true">◉</span>
        <div class="record-card-content">
          <strong>${escapeHtml(record.title || "Untitled memory")}</strong>
          <div class="record-card-sub">
            <span>${escapeHtml(speaker)} · ${escapeHtml(date)}${place}</span>
            <span class="record-badge-mini">${segCount} moment${segCount === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>`;
    }).join("") : `<div class="transcript-empty">Your archive is empty. Select "＋ Add recording" to begin.</div>`;
  }

  function metadataInput(label, key, value, placeholder) {
    return `<label class="metadata-field">${escapeHtml(label)}<input data-metadata="${key}" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder || "")}"></label>`;
  }

  function renderDetail() {
    const record = activeRecord();
    const detail = $("#record-detail");
    if (!record) {
      detail.innerHTML = `
        <div class="empty-detail">
          <div class="empty-detail-art">
            <span class="empty-glyph">◉</span>
            <span class="empty-halo"></span>
          </div>
          <h3>Select an archival memory</h3>
          <p>Choose any recording from the directory or search results to inspect its provenance, verified metadata, and timestamped transcript evidence.</p>
        </div>`;
      return;
    }
    renderVideoAnnotations(record);
    const segments = record.segments.map((segment, index) => `
      <div class="segment-row">
        <button class="segment-time" data-seek="${segment.start}" title="Seek playback to ${formatTime(segment.start)}">▶ ${formatTime(segment.start)}</button>
        <textarea class="segment-text" data-detail-segment="${index}" aria-label="Transcript segment ${index + 1}">${escapeHtml(segment.text)}</textarea>
        <span class="segment-tools"><button class="icon-button" data-delete-segment="${index}" aria-label="Delete segment ${index + 1}" title="Delete segment">×</button></span>
      </div>`).join("");
    detail.innerHTML = `
      <div class="detail-content">
        <div class="detail-top">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span> VERIFIED LOCAL PROVENANCE</div>
            <h3>${escapeHtml(record.title || "Untitled memory")}</h3>
            <div class="detail-source">ORIGINAL SOURCE · ${escapeHtml(record.source || "Source not specified")}</div>
          </div>
          <div class="detail-actions">
            <button class="button button-outline small-button" data-open-studio>Open in studio</button>
            <button class="icon-button" data-delete-record="${escapeHtml(record.id)}" aria-label="Delete this record" title="Delete record safely">⌫</button>
          </div>
        </div>
        <div class="metadata-fields">
          ${metadataInput("TITLE", "title", record.title, "Untitled memory")}
          ${metadataInput("SOURCE FILE", "source", record.source, "Source filename")}
          ${metadataInput("SPEAKER", "speaker", record.speaker, "Unknown")}
          ${metadataInput("PLACE", "place", record.place, "Unknown")}
          ${metadataInput("DATE", "date", record.date === "Unknown" ? "" : record.date, "Unknown unless sourced")}
          ${metadataInput("LANGUAGE", "language", record.language, "Unknown")}
          ${metadataInput("TOPICS · COMMA SEPARATED", "topics", (record.topics || []).join(", "), "Add topics")}
          ${metadataInput("TAGS · COMMA SEPARATED", "tags", (record.tags || []).join(", "), "Add tags")}
        </div>
        <label class="detail-description-label">DESCRIPTION · USER ANNOTATION<textarea data-record-description rows="2">${escapeHtml(record.description || "")}</textarea></label>
        <div class="metadata-chips"><span class="chip gold">${escapeHtml(record.date || "Date unknown")}</span>${(record.topics || []).map((topic) => `<span class="chip">${escapeHtml(topic)}</span>`).join("")}${(record.tags || []).map((tag) => `<span class="chip tag-chip">#${escapeHtml(tag)}</span>`).join("")}</div>
        <div class="segment-list">
          <div class="panel-topline" style="min-height:36px;padding:0 4px;margin-bottom:8px;">
            <span style="font-size:9.5px;font-weight:700;color:var(--text-secondary);letter-spacing:0.12em;">EVIDENCE SEGMENTS (${record.segments.length})</span>
            <span style="font-size:8.5px;color:var(--teal-400);">CLICK TIMECODE TO CUE IN AUDIO DECK</span>
          </div>
          ${segments || `<p class="transcript-empty">No transcript segments yet. Add one in the Audio Studio.</p>`}
        </div>
        <div class="source-note">Original source: <strong>${escapeHtml(record.source || "not specified")}</strong> · ${escapeHtml(record.language || "Language unknown")} · Transcript text is source material; edits are local user annotations.</div>
      </div>`;
    renderArchiveList();
    renderTranscriptEditor();
  }

  function renderTranscriptEditor() {
    const record = activeRecord();
    const editor = $("#transcript-editor");
    $("#add-segment").disabled = !record;
    if (!record) {
      editor.innerHTML = `<p class="transcript-empty">Select a recording to edit its segments. No automatic transcription is active; a local speech model would be required.</p>`;
      $("#transcript-status").textContent = "Select a recording to edit its segments.";
      $("#audio-title").textContent = "Choose a recording";
      $("#audio-description").textContent = "Open an archive record or import audio from this device.";
      $("#video-description").value = "";
      $("#video-place").value = "";
      $("#video-date").value = "";
      $("#video-topics").value = "";
      $("#video-tags").value = "";
      return;
    }
    editor.innerHTML = record.segments.length ? record.segments.map((segment, index) => `
      <div class="transcript-segment"><button data-seek="${segment.start}" title="Seek to ${formatTime(segment.start)}">${formatTime(segment.start)}</button><textarea data-studio-segment="${index}" aria-label="Edit transcript at ${formatTime(segment.start)}">${escapeHtml(segment.text)}</textarea></div>`).join("")
      : `<p class="transcript-empty">No transcript segments yet. Add a segment manually; automatic transcription requires an installed local speech model.</p>`;
    $("#transcript-status").textContent = `${record.segments.length} MANUAL SEGMENT${record.segments.length === 1 ? "" : "S"} · SAVED LOCALLY`;
    $("#audio-title").textContent = record.title || "Untitled memory";
    $("#audio-description").textContent = `${record.speaker || "Unknown speaker"} · ${record.source || "Source not specified"} · ${record.date || "Date unknown"}`;
  }

  function renderVideoAnnotations(record) {
    $("#video-description").value = record.description || "";
    $("#video-place").value = record.place || "";
    $("#video-date").value = record.date === "Unknown" ? "" : record.date || "";
    $("#video-topics").value = (record.topics || []).join(", ");
    $("#video-tags").value = (record.tags || []).join(", ");
  }

  function openRecord(id, seekSeconds) {
    if (!records.some((record) => record.id === id)) return;
    activeId = id;
    renderArchiveList();
    renderDetail();
    setAudioForRecord(activeRecord());
    $("#record-detail").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    if (Number.isFinite(Number(seekSeconds))) seekTo(Number(seekSeconds));
  }

  function seekTo(seconds) {
    if (audio.src && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(Math.max(0, seconds), audio.duration);
      $("#audio-seek").value = String(Math.round(audio.currentTime / audio.duration * 1000));
      $("#current-time").textContent = formatTime(audio.currentTime);
    } else {
      showToast(`Source timestamp ${formatTime(seconds)} selected. Import the original audio file to play or seek it.`, false);
    }
  }

  function searchRecords(query) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return records.flatMap((record) => {
      const fields = [
        ["title", record.title], ["source filename", record.source], ["speaker", record.speaker],
        ["place", record.place], ["date", record.date], ["language", record.language],
        ["description annotation", record.description], ["topic metadata", (record.topics || []).join(", ")],
        ["tag metadata", (record.tags || []).join(", ")]
      ].filter(([, value]) => value);
      const meta = fields.map(([, value]) => value).join(" ").toLowerCase();
      const full = `${meta} ${record.segments.map((segment) => segment.text).join(" ")}`.toLowerCase();
      if (!terms.every((term) => full.includes(term))) return [];
      const segment = record.segments.find((item) => terms.every((term) => item.text.toLowerCase().includes(term)));
      const metadataMatch = fields.find(([, value]) => terms.every((term) => value.toLowerCase().includes(term)));
      const reason = segment ? "Matched transcript text"
        : metadataMatch ? `Matched ${metadataMatch[0]}`
          : "Matched multiple metadata fields";
      const excerpt = segment ? segment.text
        : metadataMatch ? `${metadataMatch[0][0].toUpperCase()}${metadataMatch[0].slice(1)}: ${metadataMatch[1]}`
          : fields.filter(([, value]) => terms.some((term) => value.toLowerCase().includes(term)))
            .map(([label, value]) => `${label}: ${value}`).join(" · ");
      return [{ record, segment, reason, excerpt, score: segment ? 3 : metadataMatch ? 2 : 1 }];
    }).sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title));
  }

  function highlight(text, query) {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!terms.length) return escapeHtml(text);
    return text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part) =>
      terms.some((term) => new RegExp(`^${term}$`, "i").test(part)) ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)
    ).join("");
  }

  function renderSearch(query) {
    const results = $("#search-results");
    const matches = searchRecords(query);
    const searchClear = $("#search-clear");
    if (searchClear) searchClear.hidden = !query.trim();
    if (!query.trim()) {
      results.classList.remove("visible");
      results.innerHTML = "";
      return;
    }
    results.classList.add("visible");
    results.innerHTML = matches.length ? matches.slice(0, 12).map(({ record, segment, reason, excerpt }) => {
      const stamp = segment ? formatTime(segment.start) : "Timestamp unavailable";
      return `<div class="result-item" data-result-id="${escapeHtml(record.id)}" data-result-time="${segment ? segment.start : ""}" tabindex="0" role="button" aria-label="Open ${escapeHtml(record.title)} at ${stamp}">
        <div>
          <div class="result-title">${escapeHtml(record.title)}</div>
          <div class="result-meta">
            <span>FILE: ${escapeHtml(record.source)}</span>
            <span>·</span>
            <span style="color:var(--teal-300);">⏱ ${stamp}</span>
            <span>·</span>
            <span>${escapeHtml(record.language || "Language unknown")}</span>
          </div>
        </div>
        <div class="result-quote">“${highlight(excerpt, query.trim())}”</div>
        <div class="result-reason"><span class="status-dot" style="width:5px;height:5px;"></span> ${escapeHtml(reason)} · ${escapeHtml(record.speaker || "Speaker unknown")}</div>
        <span class="result-open">INSPECT EVIDENCE ↗</span>
      </div>`;
    }).join("") : `<div class="transcript-empty">No keyword matches found for "${escapeHtml(query)}". Try a voice, place, topic, or source filename.</div>`;
  }

  function addRecord() {
    const record = {
      id: `record-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: "Untitled memory", source: "Source not specified", speaker: "",
      place: "", date: "", language: "", topics: [], tags: [], description: "",
      duration: 0, segments: []
    };
    records.unshift(record);
    if (saveArchive()) {
      activeId = record.id;
      renderStats(); renderArchiveList(); renderDetail();
      setAudioForRecord(record);
      showToast("A new local archive record is ready to edit.");
      $("#record-detail").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      setTimeout(() => $("#record-detail [data-metadata=title]")?.focus(), 150);
    } else {
      records = records.filter((item) => item.id !== record.id);
    }
  }

  function addSegment() {
    const record = activeRecord();
    if (!record) return;
    const time = audio.src && Number.isFinite(audio.currentTime) ? Math.floor(audio.currentTime) : 0;
    record.segments.push({ start: time, end: time + 5, text: "" });
    saveArchive(); renderDetail();
    const fields = document.querySelectorAll("[data-studio-segment]");
    fields[fields.length - 1]?.focus();
    showToast("Blank transcript segment added. Enter source-backed text; no transcription was generated.");
  }

  function updateMetadata(input) {
    const record = activeRecord();
    if (!record) return;
    const key = input.dataset.metadata;
    record[key] = ["topics", "tags"].includes(key) ? input.value.split(",").map((value) => value.trim()).filter(Boolean) : input.value.trim();
    if (key === "date" && !record.date) record.date = "";
    saveArchive();
    renderArchiveList();
    renderStats();
    updateGraph();
    renderDetail();
  }

  function updateSegment(index, text) {
    const record = activeRecord();
    if (!record || !record.segments[index]) return;
    record.segments[index].text = text;
    saveArchive();
    $("#transcript-status").textContent = "EDIT SAVED LOCALLY · SOURCE TEXT MAY BE USER-ANNOTATED";
  }

  function loadAudioFile(file) {
    if (!file || !file.type.startsWith("audio/")) {
      showToast("Choose a supported audio file.", true);
      return;
    }
    const mediaKey = activeId || "__unassigned__";
    const previousUrl = audioMediaByRecord.get(mediaKey);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    activeMediaUrl = URL.createObjectURL(file);
    audioMediaByRecord.set(mediaKey, activeMediaUrl);
    audio.src = activeMediaUrl;
    audio.load();
    $("#audio-file-label").textContent = file.name;
    $("#wave-placeholder").hidden = true;
    $("#play-button").disabled = false;
    $("#audio-seek").disabled = false;
    const record = activeRecord();
    if (record) {
      record.source = file.name;
      record.duration = 0;
      saveArchive();
      renderDetail();
    }
    if (!record) {
      $("#audio-title").textContent = file.name;
      $("#audio-description").textContent = "Local audio · no archive record selected.";
    }
    showToast("Local audio loaded in this browser session. The file was not uploaded or persisted.");
  }

  function setAudioForRecord(record) {
    const url = record ? audioMediaByRecord.get(record.id) : null;
    if (url) {
      if (activeMediaUrl !== url) {
        activeMediaUrl = url;
        audio.src = url;
        audio.load();
      }
      $("#audio-file-label").textContent = record.source || "LOCAL AUDIO";
      $("#wave-placeholder").hidden = true;
      $("#play-button").disabled = false;
      $("#audio-seek").disabled = false;
      return;
    }
    if (activeMediaUrl) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      activeMediaUrl = null;
    }
    $("#audio-file-label").textContent = "NO MEDIA LOADED";
    $("#wave-placeholder").hidden = false;
    $("#play-button").disabled = true;
    $("#audio-seek").disabled = true;
    $("#audio-seek").value = "0";
    $("#current-time").textContent = "00:00";
    $("#duration-time").textContent = "00:00";
    drawWaveform();
  }

  function releaseRecordAudio(recordId) {
    const url = audioMediaByRecord.get(recordId);
    if (url) {
      URL.revokeObjectURL(url);
      audioMediaByRecord.delete(recordId);
      if (activeMediaUrl === url) setAudioForRecord(null);
    }
  }

  function setupAnalyser() {
    if (analyser) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      audioContext = new AudioContextClass();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      mediaSource = audioContext.createMediaElementSource(audio);
      mediaSource.connect(analyser);
      analyser.connect(audioContext.destination);
    } catch (error) {
      console.error("Live audio visualization is unavailable:", error);
      analyser = null;
      showToast("Audio playback is available, but this browser cannot show a live signal visualization.", true);
    }
  }

  function drawWaveform() {
    const canvas = $("#wave-canvas");
    const context = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(rect.width * dpr), height = Math.floor(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.clearRect(0, 0, width, height);
    const mid = height / 2;
    context.strokeStyle = "rgba(94,206,227,.24)";
    context.beginPath(); context.moveTo(0, mid); context.lineTo(width, mid); context.stroke();
    const progress = Number(audio.duration) > 0 ? audio.currentTime / audio.duration : 0;
    const count = 100;
    const data = new Uint8Array(analyser ? analyser.frequencyBinCount : count);
    if (analyser && !audio.paused) analyser.getByteTimeDomainData(data);
    for (let index = 0; index < count; index++) {
      const x = index / count * width;
      const live = analyser && !audio.paused ? Math.abs((data[Math.floor(index / count * data.length)] - 128) / 128) : 0;
      const amplitude = live * height * .42;
      context.strokeStyle = index / count < progress ? "#71deed" : "rgba(116,139,173,.54)";
      context.beginPath(); context.moveTo(x, mid - amplitude); context.lineTo(x, mid + amplitude); context.stroke();
    }
    if (audio.src) {
      context.fillStyle = "#b5f6fb";
      context.shadowColor = "#6fe5f4";
      context.shadowBlur = 12 * dpr;
      context.fillRect(progress * width - dpr, 0, 2 * dpr, height);
      context.shadowBlur = 0;
    }
  }

  function animateWaveform() {
    drawWaveform();
    if (!audio.paused) waveAnimationFrame = requestAnimationFrame(animateWaveform);
    else waveAnimationFrame = 0;
  }

  function loadVideoFile(file) {
    if (!file || !file.type.startsWith("video/")) {
      showToast("Choose a supported video file.", true);
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file);
    const player = $("#video-player");
    player.src = videoUrl;
    player.hidden = false;
    $("#video-tools").hidden = false;
    $("#video-drop").hidden = true;
    $("#frame-canvas").hidden = true;
    showToast("Local video preview ready. Frame capture works when browser playback permits it.");
  }

  function saveVideoNotes() {
    const record = activeRecord();
    if (!record) {
      showToast("Select or add an archive record before attaching these annotations.", true);
      return;
    }
    record.description = $("#video-description").value.trim();
    record.place = $("#video-place").value.trim();
    record.date = $("#video-date").value.trim();
    record.topics = $("#video-topics").value.split(",").map((value) => value.trim()).filter(Boolean);
    record.tags = $("#video-tags").value.split(",").map((value) => value.trim()).filter(Boolean);
    if (saveArchive()) {
      renderArchiveList(); renderDetail(); updateGraph();
      showToast("User annotations saved to this record on this device.");
    }
  }

  function validateRecordsForExport(sourceRecords) {
    if (!validRecords(sourceRecords)) throw new Error("Archive validation failed. Check metadata and segment timestamps.");
    for (const record of sourceRecords) {
      const title = record.title.trim().toLowerCase();
      const source = record.source.trim().toLowerCase();
      if (!title || title === PLACEHOLDER_TITLE.toLowerCase()) {
        throw new Error("Each record needs a real title before export; replace the placeholder title.");
      }
      if (!source || source === PLACEHOLDER_SOURCE.toLowerCase()) {
        throw new Error("Each record needs a real source filename before export; replace the placeholder source.");
      }
    }
  }

  function validateForExport() {
    validateRecordsForExport(records);
  }

  function csvCell(value) {
    const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function toJson(sourceRecords) {
    validateRecordsForExport(sourceRecords);
    return JSON.stringify({ format: "CHRONOS AI local archive", version: 1, exportedAt: new Date().toISOString(), records: sourceRecords }, null, 2);
  }

  function toCsv(sourceRecords) {
    validateRecordsForExport(sourceRecords);
    const columns = ["record_id", "title", "source", "speaker", "place", "date", "language", "topics", "tags", "description", "segment_start_seconds", "segment_end_seconds", "transcript"];
    const rows = sourceRecords.flatMap((record) => record.segments.length ? record.segments.map((segment) => [
      record.id, record.title, record.source, record.speaker, record.place, record.date, record.language,
      record.topics, record.tags, record.description, segment.start, segment.end, segment.text
    ]) : [[record.id, record.title, record.source, record.speaker, record.place, record.date, record.language, record.topics, record.tags, record.description, "", "", ""]]);
    return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  function toSrtTime(seconds) {
    const ms = Math.round(seconds * 1000);
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  }

  function toSrt(sourceRecords) {
    validateRecordsForExport(sourceRecords);
    const subtitles = sourceRecords.flatMap((record) => record.segments.filter((segment) => segment.text.trim()).map((segment) => ({ record, segment })));
    if (!subtitles.length) throw new Error("There are no transcript segments to export as subtitles.");
    return subtitles.map(({ record, segment }, index) => `${index + 1}\n${toSrtTime(segment.start)} --> ${toSrtTime(segment.end)}\n[${record.title}] ${segment.text.trim()}`).join("\n\n") + "\n";
  }

  function downloadExport(format) {
    try {
      validateForExport();
      let content, type, filename;
      if (format === "json") {
        content = toJson(records);
        type = "application/json"; filename = "chronos-archive.json";
      } else if (format === "csv") {
        content = toCsv(records);
        type = "text/csv;charset=utf-8"; filename = "chronos-archive.csv";
      } else if (format === "srt") {
        content = toSrt(records);
        type = "application/x-subrip;charset=utf-8"; filename = "chronos-subtitles.srt";
      } else {
        throw new Error("Unknown export format.");
      }
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`${filename} exported successfully · ${records.length} record${records.length === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Export failed:", error);
      showToast(`Export failed: ${error.message}`, true);
    }
  }

  const graphCanvas = $("#graph-canvas");
  const graphContext = graphCanvas.getContext("2d");
  let graphNodes = [];
  let graphEdges = [];
  let graphRotation = { x: -.26, y: .25 };
  let graphZoom = 1;
  let dragState = null;
  let selectedNodeId = null;

  function graphData() {
    const nodes = [], edges = [], keys = new Map();
    const addEntity = (kind, label, uniqueKey) => {
      if (!label) return null;
      const key = uniqueKey || `${kind}:${label.toLowerCase()}`;
      if (keys.has(key)) return keys.get(key);
      const id = `node-${nodes.length}`;
      const index = nodes.length;
      const angle = index * 2.399963;
      const y = 1 - 2 * ((index + 0.5) / Math.max(1, records.length * 3 + 1));
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const node = { id, kind, label, x: Math.cos(angle) * radius * (1.3 + index % 3 * .15), y: y * 1.65, z: Math.sin(angle) * radius * 1.3 };
      nodes.push(node); keys.set(key, id); return id;
    };
    records.forEach((record, index) => {
      const id = addEntity("record", record.title || "Untitled memory", `record:${record.id}`);
      const node = nodes.find((item) => item.id === id);
      if (node) { node.x = (index - (records.length - 1) / 2) * 1.15; node.y = Math.sin(index * 2.2) * .5; node.z = Math.cos(index * 2.4) * .65; node.recordId = record.id; }
      for (const [kind, label] of [["speaker", record.speaker], ["place", record.place]]) {
        const target = addEntity(kind, label);
        if (target && target !== id) edges.push({ from: id, to: target });
      }
      (record.topics || []).forEach((topic) => {
        const target = addEntity("topic", topic);
        if (target && target !== id) edges.push({ from: id, to: target });
      });
      (record.tags || []).forEach((tag) => {
        const target = addEntity("tag", tag);
        if (target && target !== id) edges.push({ from: id, to: target });
      });
    });
    return { nodes, edges };
  }

  function projectNode(node, width, height, time) {
    const cy = Math.cos(graphRotation.y), sy = Math.sin(graphRotation.y);
    const cx = Math.cos(graphRotation.x), sx = Math.sin(graphRotation.x);
    const spin = reducedMotion ? 0 : time * .000035;
    const x0 = node.x * Math.cos(spin) - node.z * Math.sin(spin);
    const z0 = node.x * Math.sin(spin) + node.z * Math.cos(spin);
    const x1 = x0 * cy + z0 * sy;
    const z1 = -x0 * sy + z0 * cy;
    const y1 = node.y * cx - z1 * sx;
    const z2 = node.y * sx + z1 * cx;
    const perspective = 4.7 / (4.7 + z2);
    return { x: width / 2 + x1 * width * .19 * perspective * graphZoom, y: height / 2 + y1 * height * .24 * perspective * graphZoom, scale: perspective, z: z2 };
  }

  function updateGraph() {
    const data = graphData();
    graphNodes = data.nodes; graphEdges = data.edges;
    renderGraph(performance.now());
  }

  function selectGraphNode(node) {
    selectedNodeId = node.id;
    const inspector = $("#graph-inspector");
    if (node.recordId) {
      const record = records.find((item) => item.id === node.recordId);
      const connections = graphEdges.filter((edge) => edge.from === node.id).length;
      inspector.innerHTML = `<span class="inspector-label">RECORDING · ${connections} EXPLICIT CONNECTION${connections === 1 ? "" : "S"}</span><h3>${escapeHtml(node.label)}</h3><p>${escapeHtml(record?.speaker || "Speaker unknown")} · ${escapeHtml(record?.place || "Place unknown")} · ${escapeHtml(record?.date || "Date unknown")}</p><button data-graph-open="${escapeHtml(node.recordId)}">OPEN THIS RECORD ↗</button>`;
    } else {
      const linkedRecords = graphEdges.filter((edge) => edge.to === node.id).map((edge) => graphNodes.find((item) => item.id === edge.from)).filter(Boolean);
      inspector.innerHTML = `<span class="inspector-label">${escapeHtml(node.kind.toUpperCase())} · ${linkedRecords.length} LINKED RECORD${linkedRecords.length === 1 ? "" : "S"}</span><h3>${escapeHtml(node.label)}</h3><p>${linkedRecords.map((item) => escapeHtml(item.label)).join(" · ") || "No linked records."}</p>`;
    }
    renderGraph(performance.now());
  }

  function resizeGraph() { renderGraph(performance.now()); }

  function bindEvents() {
    $("#add-record").addEventListener("click", addRecord);
    $("#search-input").addEventListener("input", (event) => renderSearch(event.target.value));
    $("#search-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const first = $("#search-results .result-item");
        if (first) first.click();
      }
    });
    $("#record-list").addEventListener("click", (event) => {
      const card = event.target.closest("[data-record-id]");
      if (card) openRecord(card.dataset.recordId);
    });
    $("#record-list").addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-record-id]")) {
        event.preventDefault(); openRecord(event.target.dataset.recordId);
      }
    });
    $("#search-results").addEventListener("click", (event) => {
      const result = event.target.closest("[data-result-id]");
      if (result) openRecord(result.dataset.resultId, result.dataset.resultTime === "" ? undefined : Number(result.dataset.resultTime));
    });
    $("#search-results").addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-result-id]")) {
        event.preventDefault(); event.target.click();
      }
    });
    $("#record-detail").addEventListener("click", (event) => {
      const seek = event.target.closest("[data-seek]");
      if (seek) { seekTo(Number(seek.dataset.seek)); return; }
      if (event.target.closest("[data-open-studio]")) { $("#studio").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" }); return; }
      const deleteSegmentButton = event.target.closest("[data-delete-segment]");
      if (deleteSegmentButton) {
        const record = activeRecord();
        if (record) { record.segments.splice(Number(deleteSegmentButton.dataset.deleteSegment), 1); saveArchive(); renderDetail(); showToast("Transcript segment deleted."); }
        return;
      }
      const deleteRecordButton = event.target.closest("[data-delete-record]");
      if (deleteRecordButton) {
        const recId = deleteRecordButton.dataset.deleteRecord;
        const targetRec = records.find((record) => record.id === recId);
        if (targetRec) {
          pendingDeleteId = recId;
          const targetTitle = $("#delete-target-title");
          if (targetTitle) targetTitle.textContent = `"${targetRec.title || "Untitled memory"}"`;
          const modal = $("#delete-confirm-modal");
          if (modal) modal.hidden = false;
        }
      }
    });
    $("#record-detail").addEventListener("change", (event) => {
      if (event.target.matches("[data-metadata]")) {
        updateMetadata(event.target);
        if (event.target.dataset.metadata === "description") renderDetail();
      }
    });
    $("#record-detail").addEventListener("input", (event) => {
      if (event.target.matches("[data-detail-segment]")) updateSegment(Number(event.target.dataset.detailSegment), event.target.value);
      if (event.target.matches("[data-record-description]")) {
        const record = activeRecord();
        if (record) { record.description = event.target.value; saveArchive(); }
      }
    });
    $("#transcript-editor").addEventListener("click", (event) => {
      const seek = event.target.closest("[data-seek]");
      if (seek) seekTo(Number(seek.dataset.seek));
    });
    $("#transcript-editor").addEventListener("input", (event) => {
      if (event.target.matches("[data-studio-segment]")) updateSegment(Number(event.target.dataset.studioSegment), event.target.value);
    });
    $("#add-segment").addEventListener("click", addSegment);
    $("#audio-upload").addEventListener("change", (event) => loadAudioFile(event.target.files[0]));
    $("#play-button").addEventListener("click", async () => {
      if (!audio.src) return;
      try {
        setupAnalyser();
        if (audioContext?.state === "suspended") await audioContext.resume();
        if (audio.paused) await audio.play();
        else audio.pause();
      } catch (error) {
        console.error("Audio playback could not start:", error);
        showToast(`Audio playback could not start: ${error.message || "browser playback is unavailable."}`, true);
      }
    });
    audio.addEventListener("play", () => {
      $("#play-button").textContent = "Ⅱ"; $("#play-button").setAttribute("aria-label", "Pause audio");
      if (!reducedMotion && !waveAnimationFrame) waveAnimationFrame = requestAnimationFrame(animateWaveform);
    });
    audio.addEventListener("pause", () => {
      $("#play-button").textContent = "▶"; $("#play-button").setAttribute("aria-label", "Play audio");
      if (waveAnimationFrame) cancelAnimationFrame(waveAnimationFrame);
      waveAnimationFrame = 0;
      drawWaveform();
    });
    audio.addEventListener("loadedmetadata", () => {
      $("#duration-time").textContent = formatTime(audio.duration);
      const record = activeRecord();
      if (record && Number.isFinite(audio.duration)) { record.duration = audio.duration; saveArchive(); }
    });
    audio.addEventListener("timeupdate", () => {
      $("#current-time").textContent = formatTime(audio.currentTime);
      if (Number.isFinite(audio.duration) && audio.duration > 0) $("#audio-seek").value = String(Math.round(audio.currentTime / audio.duration * 1000));
      if (reducedMotion) drawWaveform();
    });
    audio.addEventListener("error", () => showToast("This media file could not be decoded by the browser. Try a supported local audio format.", true));
    $("#audio-seek").addEventListener("input", (event) => {
      if (Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Number(event.target.value) / 1000;
    });
    $("#wave-canvas").addEventListener("click", (event) => {
      if (!Number.isFinite(audio.duration)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      audio.currentTime = audio.duration * Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    });
    $("#volume-button").addEventListener("click", () => {
      audio.muted = !audio.muted;
      $("#volume-button").setAttribute("aria-label", audio.muted ? "Unmute audio" : "Mute audio");
      $("#volume-button").textContent = audio.muted ? "×" : "◖";
    });
    $("#video-upload").addEventListener("change", (event) => loadVideoFile(event.target.files[0]));
    $("#video-player").addEventListener("timeupdate", () => { $("#frame-time").value = audioTimeInput($("#video-player").currentTime); });
    $("#seek-frame").addEventListener("click", () => {
      const player = $("#video-player");
      const time = Number($("#frame-time").value);
      if (!Number.isFinite(time) || time < 0) { showToast("Enter a valid non-negative frame timestamp.", true); return; }
      if (Number.isFinite(player.duration)) player.currentTime = Math.min(time, player.duration);
      else showToast("Video duration is not available yet.", true);
    });
    $("#capture-frame").addEventListener("click", () => {
      const player = $("#video-player"), canvas = $("#frame-canvas");
      if (!player.videoWidth || !player.videoHeight) { showToast("Wait for a video frame to load before capturing.", true); return; }
      try {
        canvas.width = player.videoWidth; canvas.height = player.videoHeight;
        canvas.getContext("2d").drawImage(player, 0, 0, canvas.width, canvas.height);
        canvas.hidden = false;
        const downloadWrap = $("#frame-download-wrap");
        if (downloadWrap) downloadWrap.hidden = false;
        $("#video-description").value = `User-captured frame at ${formatTime(player.currentTime)} from ${$("#video-upload").files[0]?.name || "local video"}.`;
        showToast(`Frame captured locally at ${formatTime(player.currentTime)}. Description is a user annotation, not generated.`);
      } catch (error) {
        console.error("Frame capture failed:", error);
        showToast("The browser could not capture this frame. Try another supported video file.", true);
      }
    });
    $("#save-video-notes").addEventListener("click", saveVideoNotes);
    document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => downloadExport(button.dataset.export)));
    $("#graph-reset").addEventListener("click", () => { graphRotation = { x: -.26, y: .25 }; graphZoom = 1; renderGraph(performance.now()); });
    $("#graph-zoom-in").addEventListener("click", () => { graphZoom = Math.min(2.5, graphZoom * 1.15); renderGraph(performance.now()); });
    $("#graph-zoom-out").addEventListener("click", () => { graphZoom = Math.max(.55, graphZoom / 1.15); renderGraph(performance.now()); });
    $("#graph-inspector").addEventListener("click", (event) => {
      const button = event.target.closest("[data-graph-open]");
      if (button) { openRecord(button.dataset.graphOpen); $("#archive").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" }); }
    });
    graphCanvas.addEventListener("pointerdown", (event) => {
      dragState = { x: event.clientX, y: event.clientY, moved: false };
      graphCanvas.setPointerCapture(event.pointerId);
    });
    graphCanvas.addEventListener("pointermove", (event) => {
      if (!dragState) return;
      const dx = event.clientX - dragState.x, dy = event.clientY - dragState.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) dragState.moved = true;
      graphRotation.y += dx * .008; graphRotation.x += dy * .008;
      dragState.x = event.clientX; dragState.y = event.clientY;
      renderGraph(performance.now());
    });
    graphCanvas.addEventListener("pointerup", (event) => {
      if (dragState && !dragState.moved) {
        const rect = graphCanvas.getBoundingClientRect();
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const nearest = graphNodes.map((node) => ({ node, ...projectNode(node, rect.width, rect.height, performance.now()) }))
          .map((item) => ({ ...item, distance: Math.hypot(item.x - point.x, item.y - point.y) }))
          .filter((item) => item.distance < 24).sort((a, b) => a.distance - b.distance)[0];
        if (nearest) selectGraphNode(nearest.node);
      }
      dragState = null;
    });
    graphCanvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      graphZoom = Math.max(.55, Math.min(2.5, graphZoom * (event.deltaY < 0 ? 1.08 : .92)));
      renderGraph(performance.now());
    }, { passive: false });
    graphCanvas.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        graphRotation.y += event.key === "ArrowLeft" ? -.15 : event.key === "ArrowRight" ? .15 : 0;
        graphRotation.x += event.key === "ArrowUp" ? -.15 : event.key === "ArrowDown" ? .15 : 0;
        renderGraph(performance.now());
      } else if (event.key === "+" || event.key === "=") { graphZoom = Math.min(2.5, graphZoom * 1.15); renderGraph(performance.now()); }
      else if (event.key === "-") { graphZoom = Math.max(.55, graphZoom / 1.15); renderGraph(performance.now()); }
      else if (event.key === "Enter") {
        const center = { x: graphCanvas.clientWidth / 2, y: graphCanvas.clientHeight / 2 };
        const nearest = graphNodes.map((node) => ({ node, ...projectNode(node, graphCanvas.clientWidth, graphCanvas.clientHeight, performance.now()) }))
          .sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y))[0];
        if (nearest) selectGraphNode(nearest.node);
      }
    });
    // Safe Delete Record Modal Handlers
    $("#cancel-delete-record")?.addEventListener("click", () => {
      pendingDeleteId = null;
      const modal = $("#delete-confirm-modal");
      if (modal) modal.hidden = true;
    });
    $("#delete-confirm-modal")?.addEventListener("click", (event) => {
      if (event.target.id === "delete-confirm-modal") {
        pendingDeleteId = null;
        event.target.hidden = true;
      }
    });
    $("#confirm-delete-record")?.addEventListener("click", () => {
      if (!pendingDeleteId) return;
      const recId = pendingDeleteId;
      pendingDeleteId = null;
      const modal = $("#delete-confirm-modal");
      if (modal) modal.hidden = true;
      const deletedIndex = records.findIndex((record) => record.id === recId);
      const deletedRecord = records[deletedIndex];
      if (deletedIndex >= 0) records.splice(deletedIndex, 1);
      activeId = null;
      if (saveArchive()) {
        releaseRecordAudio(recId);
        renderArchiveList();
        renderDetail();
        renderTranscriptEditor();
        updateGraph();
        showToast("Record removed from this device's archive.");
      } else if (deletedRecord) {
        records.splice(deletedIndex, 0, deletedRecord);
        activeId = deletedRecord.id;
        renderStats();
        renderArchiveList();
        renderDetail();
        updateGraph();
      }
    });

    // Search Controls: Clear & Shortcut Filters
    $("#search-clear")?.addEventListener("click", () => {
      const input = $("#search-input");
      input.value = "";
      renderSearch("");
      input.focus();
    });
    document.querySelectorAll("[data-search-term]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = $("#search-input");
        input.value = btn.dataset.searchTerm;
        renderSearch(input.value);
        $("#archive").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
      });
    });

    // Video Error Listener & Frame Download
    const video = $("#video-player");
    video.addEventListener("error", () => {
      showToast("This video file could not be decoded by the browser. Try a supported local video format.", true);
      const notice = $("#video-error-notice");
      if (notice) notice.hidden = false;
    });
    video.addEventListener("loadedmetadata", () => {
      const notice = $("#video-error-notice");
      if (notice) notice.hidden = true;
    });
    $("#download-frame-btn")?.addEventListener("click", () => {
      const canvas = $("#frame-canvas");
      if (!canvas.width || !canvas.height) return;
      try {
        const link = document.createElement("a");
        link.download = `chronos-frame-${Math.floor(video.currentTime || 0)}s.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        showToast("Captured still frame downloaded as PNG.");
      } catch (err) {
        console.error("Frame download failed:", err);
        showToast("Could not download canvas frame.", true);
      }
    });

    // Topbar Nav Link Scroll Sync
    window.addEventListener("scroll", () => {
      const sections = document.querySelectorAll("main > section");
      const navLinks = document.querySelectorAll(".topnav .nav-item");
      let currentSection = "";
      sections.forEach((sec) => {
        const top = sec.offsetTop - 140;
        if (window.scrollY >= top) currentSection = sec.getAttribute("id");
      });
      navLinks.forEach((link) => {
        link.classList.toggle("active", link.getAttribute("href") === `#${currentSection}`);
      });
    }, { passive: true });

    window.addEventListener("resize", resizeGraph);
  }

  function audioTimeInput(seconds) {
    return Number(seconds).toFixed(1);
  }

  function animateGraph(time) {
    renderGraph(time);
    graphAnimationFrame = requestAnimationFrame(animateGraph);
  }

  function setGraphAnimation(shouldAnimate) {
    if (shouldAnimate && !reducedMotion && !graphAnimationFrame) {
      graphAnimationFrame = requestAnimationFrame(animateGraph);
    } else if ((!shouldAnimate || reducedMotion) && graphAnimationFrame) {
      cancelAnimationFrame(graphAnimationFrame);
      graphAnimationFrame = 0;
    }
    renderGraph(performance.now());
  }

  function renderGraph(time) {
    if (!graphCanvas || !graphContext) return;
    const coordsEl = $("#graph-coords");
    if (coordsEl) {
      const degX = Math.round(graphRotation.x * (180 / Math.PI)) % 360;
      const degY = Math.round(graphRotation.y * (180 / Math.PI)) % 360;
      coordsEl.textContent = `PITCH ${degX}° · YAW ${degY}° · ZOOM ${graphZoom.toFixed(1)}x`;
    }
    const rect = graphCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(rect.width * dpr), height = Math.floor(rect.height * dpr);
    if (graphCanvas.width !== width || graphCanvas.height !== height) { graphCanvas.width = width; graphCanvas.height = height; }
    graphContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height;
    graphContext.clearRect(0, 0, w, h);
    const positions = new Map(graphNodes.map((node) => [node.id, { node, ...projectNode(node, w, h, time) }]));
    graphEdges.forEach((edge, index) => {
      const a = positions.get(edge.from), b = positions.get(edge.to);
      if (!a || !b) return;
      graphContext.beginPath(); graphContext.moveTo(a.x, a.y); graphContext.lineTo(b.x, b.y);
      graphContext.strokeStyle = `rgba(99,191,216,${.12 + ((index % 4) * .025)})`;
      graphContext.lineWidth = .7 + Math.max(a.scale, b.scale) * .45;
      graphContext.stroke();
    });
    [...positions.values()].sort((a, b) => b.z - a.z).forEach(({ node, x, y, scale }) => {
      const selected = node.id === selectedNodeId;
      const radius = (node.kind === "record" ? 6.2 : 3.2) * scale + (selected ? 2 : 0);
      const color = node.kind === "record" ? "#73e7f2" : node.kind === "tag" ? "#d48aff" : node.kind === "topic" ? "#a78aff" : "#dfbd78";
      if (node.kind === "record" || selected) {
        graphContext.beginPath(); graphContext.arc(x, y, radius * 2.9, 0, Math.PI * 2);
        graphContext.fillStyle = `${color}14`; graphContext.fill();
      }
      graphContext.beginPath(); graphContext.arc(x, y, radius, 0, Math.PI * 2);
      graphContext.fillStyle = color; graphContext.shadowColor = color; graphContext.shadowBlur = selected ? 20 : 10;
      graphContext.fill(); graphContext.shadowBlur = 0;
      if (node.kind === "record" || selected) {
        graphContext.font = `${node.kind === "record" ? 10 : 9}px Segoe UI, sans-serif`;
        graphContext.fillStyle = selected ? "#f5f7fb" : "rgba(212,224,237,.78)";
        graphContext.fillText(node.label.slice(0, 26), x + radius + 7, y + 3);
      }
    });
  }

  function initialize() {
    renderStats();
    renderArchiveList();
    renderTranscriptEditor();
    bindEvents();
    updateGraph();
    drawWaveform();
    if (archiveLoadError) showToast(archiveLoadError, true);
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => setGraphAnimation(entries.some((entry) => entry.isIntersecting)), { rootMargin: "100px" });
      observer.observe(graphCanvas);
    } else {
      setGraphAnimation(true);
    }
    window.CHRONOS = Object.freeze({
      searchRecords, validRecords, formatTime, toSrtTime,
      toCsv, toSrt, toJson, validateForExport
    });
    window.addEventListener("beforeunload", () => {
      for (const url of audioMediaByRecord.values()) URL.revokeObjectURL(url);
      if (activeMediaUrl && !audioMediaByRecord.size) URL.revokeObjectURL(activeMediaUrl);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    });
  }

  initialize();
})();
