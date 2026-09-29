// ── State ──────────────────────────────────────────────────
const MAX_SECONDS = 90;
let isRecording = false;
let timerInterval = null;
let secondsElapsed = 0;
let selectedFile = null;
let currentMode = 'record';

// Audio nodes
let audioCtx = null;
let analyserNode = null;
let processorNode = null;
let sourceNode = null;
let micStream = null;
let pcmChunks = [];

const canvas = document.getElementById('waveform');
const canvasCtx = canvas.getContext('2d');
let animationId = null;

// ── WAV Builder ────────────────────────────────────────────
// Records raw PCM at 16kHz and builds a proper WAV blob
// that Azure accepts without any server-side conversion

function pcmToWav(chunks, sampleRate) {
  const totalSamples = chunks.reduce((s, c) => s + c.length, 0);
  const buf  = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buf);
  const str  = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0,  'RIFF');
  view.setUint32(4,  36 + totalSamples * 2, true);
  str(8,  'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);           // subchunk size
  view.setUint16(20, 1,  true);           // PCM
  view.setUint16(22, 1,  true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2,  true);           // block align
  view.setUint16(34, 16, true);           // 16-bit
  str(36, 'data');
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ── Tab Switching ──────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  document.getElementById('recordMode').style.display = mode === 'record' ? 'block' : 'none';
  document.getElementById('uploadMode').style.display = mode === 'upload' ? 'block' : 'none';
  document.getElementById('tabRecord').classList.toggle('active', mode === 'record');
  document.getElementById('tabUpload').classList.toggle('active', mode === 'upload');
}

// ── Recording ──────────────────────────────────────────────
async function toggleRecording() {
  if (isRecording) stopRecording();
  else await startRecording();
}

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    showError('Microphone access denied. Please allow microphone and refresh.');
    return;
  }

  const TARGET_RATE = 16000;
  audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
  sourceNode   = audioCtx.createMediaStreamSource(micStream);
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;

  // ScriptProcessor captures raw PCM
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
  pcmChunks = [];

  processorNode.onaudioprocess = (e) => {
    const float32 = e.inputBuffer.getChannelData(0);
    const int16   = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
    }
    pcmChunks.push(int16);
  };

  sourceNode.connect(analyserNode);
  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination);

  isRecording = true;
  secondsElapsed = 0;

  const btn  = document.getElementById('recordBtn');
  btn.classList.add('recording');
  document.getElementById('recordBtnText').textContent = 'Tap to Stop';
  document.getElementById('recordIcon').innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26" fill="none">
    <rect x="8" y="8" width="10" height="10" rx="2" fill="white"/>
  </svg>`;
  document.getElementById('hint').textContent = 'Recording… speak naturally in English. Click to stop when done.';

  const progressWrap = document.getElementById('progressBarWrap');
  const progressFill = document.getElementById('progressBarFill');
  progressWrap.style.display = 'block';
  progressFill.style.width = '0%';
  progressFill.classList.remove('near-end');

  timerInterval = setInterval(() => {
    secondsElapsed++;
    document.getElementById('timer').textContent = formatTime(secondsElapsed);

    const pct = (secondsElapsed / MAX_SECONDS) * 100;
    progressFill.style.width = Math.min(pct, 100) + '%';
    if (pct >= 75) progressFill.classList.add('near-end');

    if (secondsElapsed >= MAX_SECONDS) stopRecording();
  }, 1000);

  document.getElementById('waveformPlaceholder').classList.add('hidden');
  drawWaveform();
}

function stopRecording() {
  processorNode.disconnect();
  sourceNode.disconnect();
  analyserNode.disconnect();
  micStream.getTracks().forEach(t => t.stop());
  clearInterval(timerInterval);
  cancelAnimationFrame(animationId);
  isRecording = false;

  document.getElementById('progressBarWrap').style.display = 'none';

  const btn = document.getElementById('recordBtn');
  btn.classList.remove('recording');
  btn.classList.add('analyzing');
  btn.disabled = true;
  document.getElementById('recordBtnText').textContent = 'Processing…';

  const wavBlob = pcmToWav(pcmChunks, audioCtx.sampleRate);
  audioCtx.close();
  submitAudio(wavBlob, 'recording.wav');
}

// ── File Upload ────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) setSelectedFile(file);
}

function setSelectedFile(file) {
  if (!file.type.startsWith('audio/')) {
    showError('Please select a valid audio file (MP3, WAV, M4A, OGG, WebM).');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showError('File too large. Maximum size is 50 MB.');
    return;
  }
  selectedFile = file;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatBytes(file.size);
  document.getElementById('fileInfo').style.display = 'flex';
  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('uploadBtn').disabled = false;
}

function clearFile() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('dropzone').style.display = 'block';
  document.getElementById('uploadBtn').disabled = true;
}

async function submitUpload() {
  if (!selectedFile) return;
  await submitAudio(selectedFile, selectedFile.name);
}

function onDragOver(e) { e.preventDefault(); document.getElementById('dropzone').classList.add('drag-over'); }
function onDragLeave()  { document.getElementById('dropzone').classList.remove('drag-over'); }
function onDrop(e)      { e.preventDefault(); document.getElementById('dropzone').classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) setSelectedFile(f); }

// ── Loading step animation ─────────────────────────────────
function advanceLoadingSteps() {
  const steps = ['step1', 'step2', 'step3', 'step4'];
  const delays = [0, 2000, 6000, 14000];
  steps.forEach((id, i) => {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      if (i > 0) document.getElementById(steps[i - 1])?.classList.replace('active', 'done');
      el.classList.add('active');
    }, delays[i]);
  });
}

// ── Submit ─────────────────────────────────────────────────
async function submitAudio(blob, filename) {
  showResultsPanel(true);
  advanceLoadingSteps();
  const form = new FormData();
  form.append('audio', blob, filename);

  try {
    const resp = await fetch('/api/analyze', { method: 'POST', body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Server error');
    displayResults(data);
  } catch (err) {
    showError(err.message || 'Analysis failed. Please try again.');
  }
}

// ── Waveform ───────────────────────────────────────────────
function drawWaveform() {
  animationId = requestAnimationFrame(drawWaveform);
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);

  const w = canvas.width, h = canvas.height;
  canvasCtx.clearRect(0, 0, w, h);
  const barW = (w / data.length) * 2.2;
  let x = 0;
  for (let i = 0; i < data.length; i++) {
    const barH = (data[i] / 255) * h * 0.85;
    const t = i / data.length;
    canvasCtx.fillStyle = `rgba(${Math.round(99+t*40)},${Math.round(102+t*20)},${Math.round(241-t*80)},0.85)`;
    canvasCtx.beginPath();
    canvasCtx.roundRect(x, (h - barH) / 2, barW - 1, barH, 2);
    canvasCtx.fill();
    x += barW + 1;
  }
}

// ── Results ────────────────────────────────────────────────
function showResultsPanel(loading) {
  document.getElementById('recorderPanel').style.display = 'none';
  document.getElementById('resultsPanel').style.display = 'block';
  document.getElementById('loadingState').style.display = loading ? 'flex' : 'none';
  document.getElementById('resultsContent').style.display = loading ? 'none' : 'block';
}

function displayResults(data) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('resultsContent').style.display = 'block';

  renderTranscript(data.transcript || '', data.words || []);

  const level = data.overall_cefr_level || '--';
  const badge = document.getElementById('cefrBadge');
  badge.textContent = level;
  badge.className = 'cefr-badge ' + getCefrClass(level);
  document.getElementById('cefrSummary').textContent = data.final_evaluation_summary || '';

  const az = data.azure_scores || {};
  animateBar('barPronunciation', 'valPronunciation', az.pronunciation || 0);
  animateBar('barFluency',       'valFluency',       az.fluency       || 0);
  animateBar('barAccuracy',      'valAccuracy',      az.accuracy      || 0);
  animateBar('barGrammar',       'valGrammar',       data.grammar_score_out_of_100    || 0);
  animateBar('barVocabulary',    'valVocabulary',    data.vocabulary_score_out_of_100 || 0);

  document.getElementById('grammarFeedback').textContent    = data.grammar_feedback || '';
  document.getElementById('vocabularyFeedback').textContent = data.vocabulary_feedback || '';
}

function renderTranscript(transcript, words) {
  const box = document.getElementById('transcriptText');

  if (!words || words.length === 0) {
    box.textContent = transcript;
    return;
  }

  // Match Azure words to transcript tokens (case-insensitive)
  const azureMap = {};
  words.forEach(w => {
    const key = w.word.toLowerCase().replace(/[^a-z0-9']/g, '');
    if (!azureMap[key]) azureMap[key] = [];
    azureMap[key].push(w);
  });

  const usageCount = {};
  const tokens = transcript.split(/(\s+)/);

  box.innerHTML = '';
  tokens.forEach(token => {
    if (/^\s+$/.test(token)) { box.appendChild(document.createTextNode(token)); return; }

    const key = token.toLowerCase().replace(/[^a-z0-9']/g, '');
    const list = azureMap[key];
    usageCount[key] = (usageCount[key] || 0);
    const wordData = list?.[usageCount[key] % (list.length || 1)];
    if (list) usageCount[key]++;

    const span = document.createElement('span');
    span.textContent = token;

    if (wordData) {
      const acc = wordData.accuracy;
      span.title = `Accuracy: ${acc}%`;
      if (wordData.error && wordData.error !== 'None') {
        span.classList.add('word-omission');
        span.title += ` (${wordData.error})`;
      } else if (acc >= 80) {
        span.classList.add('word-good');
      } else if (acc >= 55) {
        span.classList.add('word-fair');
      } else {
        span.classList.add('word-poor');
      }
    }
    box.appendChild(span);
  });
}

function animateBar(barId, valId, score) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  setTimeout(() => { bar.style.width = score + '%'; }, 60);
  let current = 0;
  const step  = score / 60;
  const t     = setInterval(() => {
    current = Math.min(current + step, score);
    val.textContent = Math.round(current);
    if (current >= score) clearInterval(t);
  }, 16);
}

function getCefrClass(level) {
  const l = (level || '').toUpperCase();
  if (l.startsWith('A')) return 'level-a';
  if (l.startsWith('B')) return 'level-b';
  if (l.startsWith('C')) return 'level-c';
  return '';
}

// ── Error & Reset ──────────────────────────────────────────
function showError(msg) {
  document.getElementById('recorderPanel').style.display = 'none';
  document.getElementById('resultsPanel').style.display = 'none';
  document.getElementById('errorMsg').textContent = msg;
  document.getElementById('errorBox').style.display = 'flex';
}

function resetUI() {
  isRecording = false;
  pcmChunks = [];
  secondsElapsed = 0;
  selectedFile = null;

  document.getElementById('timer').textContent = '0:00';
  document.getElementById('progressBarWrap').style.display = 'none';
  document.getElementById('progressBarFill').style.width = '0%';
  document.getElementById('progressBarFill').classList.remove('near-end');
  document.getElementById('waveformPlaceholder').classList.remove('hidden');
  canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

  const btn = document.getElementById('recordBtn');
  btn.classList.remove('recording', 'analyzing');
  btn.disabled = false;
  document.getElementById('recordBtnText').textContent = 'Tap to Record';
  document.getElementById('recordIcon').innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26" fill="none">
    <circle cx="13" cy="13" r="7" fill="white"/>
  </svg>`;
  document.getElementById('hint').textContent = 'Click the button above and allow microphone access to start.';

  document.getElementById('fileInput').value = '';
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('dropzone').style.display = 'block';
  document.getElementById('uploadBtn').disabled = true;

  document.getElementById('recorderPanel').style.display = 'block';
  document.getElementById('resultsPanel').style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';

  switchMode(currentMode);
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

// ── Helpers ────────────────────────────────────────────────
function formatTime(s) {
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
function formatBytes(b) {
  return b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';
}
