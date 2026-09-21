'use strict';

/* ABX 盲听测试前端
 *
 * 播放引擎基于 Web Audio API：
 * - A / B 解码一次，X 按题解码并缓存
 * - 切换音源 / 切换题目时保持播放位置与暂停状态
 * - 统一时间轴 = min(A 时长, B 时长)
 * - 片段循环（A-B Repeat）：在统一时间轴上设置入点 / 出点，
 *   播放到出点由 Web Audio 原生 loop 无缝回到入点；
 *   区间跨切换音源 / 换题 / 拖动进度保持，不超出统一时间轴
 * - 可选电平匹配：统一时间轴内汇总各声道样本计算 RMS，
 *   以较安静音源为基准仅衰减较响者（-24～0 dB），A / B / X 各经一个 GainNode
 */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let session = null;          // { id, numTrials, recoveryToken }
let answers = [];            // 每题 'A' | 'B' | null
let currentTrial = 0;

// ---------------------------------------------------------------------------
// 恢复标识（仅存本机浏览器 localStorage，不会离开本机）
// ---------------------------------------------------------------------------

const RECOVERY_KEY = 'abx.recovery';
let pendingResume = null;    // 页面加载时探测到的可恢复会话

function saveRecovery() {
  if (!session || !session.recoveryToken) return;
  localStorage.setItem(RECOVERY_KEY, JSON.stringify({
    token: session.recoveryToken,
    trial: currentTrial,
  }));
}

function loadSavedRecovery() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY));
    if (saved && typeof saved.token === 'string') return saved;
  } catch (_) { /* 忽略损坏的本地数据 */ }
  return null;
}

function clearRecovery() {
  localStorage.removeItem(RECOVERY_KEY);
}

let actx = null;             // AudioContext
const buffers = { A: null, B: null, X: null };
const xCache = new Map();    // trialIndex -> { buf, rms }
let timeline = 0;            // 统一时间轴（较短时长，秒）

let currentSrc = 'A';        // 当前音源 'A' | 'B' | 'X'
let playing = false;
let sourceNode = null;
let startCtxTime = 0;        // 本次播放起点对应的 AudioContext 时间
let startOffset = 0;         // 本次播放起点对应的音频位置（秒）

// 片段循环（A-B Repeat）：入点 / 出点均在统一时间轴 [0, timeline] 内
const LOOP_MIN = 0.5;        // 循环区间最短时长（秒）
const loop = { in: null, out: null, on: false };

const loopReady = () => loop.in !== null && loop.out !== null &&
  loop.out - loop.in >= LOOP_MIN;
const loopActive = () => loop.on && loopReady();

// 电平匹配：A / B / X 各经一个 GainNode，仅衰减较响音源
const gains = { A: null, B: null, X: null };
const rms = { A: NaN, B: NaN, X: NaN };   // 统一时间轴内、汇总各声道的 RMS
const gainDb = { A: 0, B: 0, X: 0 };      // 各音源调整量（dB，≤ 0）
let levelRef = null;         // 基准 RMS（较安静音源）；A/B RMS 无效时为 null
let levelMatchOn = false;    // 开关状态

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------

function show(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('#' + viewId).classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 播放引擎
// ---------------------------------------------------------------------------

function position() {
  if (!playing) return startOffset;
  let pos = startOffset + actx.currentTime - startCtxTime;
  if (loopActive()) {
    const span = loop.out - loop.in;
    // 已循环的圈数用起始位置取模计算，避免长时间播放后的浮点漂移
    pos = loop.in + ((pos - loop.in) % span + span) % span;
  }
  return Math.min(pos, timeline);
}

function stopSource() {
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch (_) { /* 已停止 */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
}

function play() {
  if (playing || !buffers[currentSrc]) return;
  const buf = buffers[currentSrc];
  // 循环开启时落在区间外（如拖到出点之后）则从入点继续
  if (loopActive()) {
    if (startOffset < loop.in || startOffset >= loop.out) startOffset = loop.in;
  } else if (startOffset >= timeline) {
    startOffset = 0;
  }
  const endLimit = Math.min(timeline, buf.duration);
  // 当前缓冲短于循环区间（理论上 X 是 A/B 的副本，不会发生）时回退为普通播放
  const looping = loopActive() && loop.in < buf.duration && loop.out - loop.in >= LOOP_MIN;
  const duration = looping ? undefined : endLimit - startOffset;
  if (!looping && duration <= 0) return;

  sourceNode = actx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(gains[currentSrc]); // 经各音源的 GainNode 输出（电平匹配）
  if (looping) {
    // loopEnd 不超过当前缓冲时长（X 可能与 A/B 略有解码差异）
    sourceNode.loop = true;
    sourceNode.loopStart = loop.in;
    sourceNode.loopEnd = Math.min(loop.out, buf.duration);
  }
  sourceNode.onended = () => {
    // 自然播放到时间轴末尾（循环开启时不会到达）
    sourceNode = null;
    playing = false;
    startOffset = 0;
    updatePlayBtn();
  };
  sourceNode.start(0, startOffset, duration);
  startCtxTime = actx.currentTime;
  playing = true;
  updatePlayBtn();
}

/** 以当前位置重建音源：循环设置变化 / 换题换缓冲时保持播放/暂停状态 */
function restartPlayback() {
  if (!playing) return;
  startOffset = position();
  stopSource();
  playing = false;
  play();
}

function pause() {
  if (!playing) return;
  startOffset = position();
  stopSource();
  playing = false;
  updatePlayBtn();
}

/** 切换 A / B / X，保持播放位置与暂停状态 */
function switchSource(which) {
  if (which === currentSrc || !buffers[which]) return;
  const pos = position();
  const wasPlaying = playing;
  stopSource();
  playing = false;
  currentSrc = which;
  startOffset = pos;
  if (wasPlaying) play();
  updateSrcButtons();
}

function seekTo(t) {
  const wasPlaying = playing;
  stopSource();
  playing = false;
  let pos = Math.max(0, Math.min(t, timeline));
  // 循环开启时，拖到区间外（出点之后或入点之前）回到入点
  if (loopActive() && (pos < loop.in || pos >= loop.out)) pos = loop.in;
  startOffset = pos;
  if (wasPlaying) play();
  updateTransport();
}

// ---------------------------------------------------------------------------
// 片段循环（A-B Repeat）
// ---------------------------------------------------------------------------

/** 将点限制在统一时间轴内（较短音频的有效时长） */
function clampLoopPoint(t) {
  return Math.max(0, Math.min(timeline, t));
}

/**
 * 设置入点 / 出点。
 * 未设入点先设出点时，入点取 0；新点导致入点 > 出点时自动交换，
 * 保证「区间至少 0.5 秒」的检查始终作用于最终区间。
 * 区间有效即自动开启循环；不足 0.5 秒则保持关闭并提示。
 */
function setLoopPoint(which) {
  const pos = clampLoopPoint(position());
  let { in: lo, out: hi } = loop;
  if (which === 'in') lo = pos;
  else hi = pos;
  if (lo === null && hi !== null) lo = 0;
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  loop.in = lo;
  loop.out = hi;
  if (loopReady()) {
    loop.on = true;
    restartPlayback(); // 播放中设置：立即按新区间循环；暂停中只更新状态
  } else {
    loop.on = false;
  }
  renderLoopUI();
}

/** 一键清除入点、出点并关闭循环；播放继续（不再循环），暂停仍暂停 */
function clearLoop() {
  loop.in = null;
  loop.out = null;
  loop.on = false;
  restartPlayback();
  renderLoopUI();
}

/** 手动开关循环（仅在区间有效时可勾选） */
function setLoopEnabled(on) {
  if (on && !loopReady()) return;
  loop.on = on;
  restartPlayback();
  renderLoopUI();
}

function pct(t) {
  return timeline > 0 ? (t / timeline) * 100 : 0;
}

function renderLoopUI() {
  const rangeEl = $('#loopRange');
  const inMark = $('#loopInMark');
  const outMark = $('#loopOutMark');
  const ready = loopReady();
  const both = loop.in !== null && loop.out !== null;
  const active = loopActive();
  const tooShort = both && !ready;

  if (both) {
    const left = pct(loop.in);
    const width = Math.max(0, pct(loop.out) - left);
    rangeEl.style.display = 'block';
    rangeEl.style.left = left + '%';
    rangeEl.style.width = width + '%';
    inMark.style.left = left + '%';
    outMark.style.left = pct(loop.out) + '%';
  } else if (loop.in !== null) {
    rangeEl.style.display = 'none';
    inMark.style.left = pct(loop.in) + '%';
    outMark.style.left = '100%';
  } else if (loop.out !== null) {
    rangeEl.style.display = 'none';
    inMark.style.left = '0%';
    outMark.style.left = pct(loop.out) + '%';
  } else {
    rangeEl.style.display = 'none';
    inMark.style.left = '0%';
    outMark.style.left = '100%';
  }
  inMark.style.display = loop.in !== null ? 'block' : 'none';
  outMark.style.display = loop.out !== null ? 'block' : 'none';

  rangeEl.classList.toggle('active', active);
  rangeEl.classList.toggle('invalid', tooShort);
  for (const m of [inMark, outMark]) {
    m.classList.toggle('active', active);
    m.classList.toggle('invalid', tooShort);
  }

  const chk = $('#chkLoop');
  chk.checked = active;
  chk.disabled = !ready;
  $('#btnLoopIn').disabled = timeline <= 0;
  $('#btnLoopOut').disabled = timeline <= 0;
  $('#btnLoopClear').disabled = loop.in === null && loop.out === null;

  const info = $('#loopInfo');
  info.classList.toggle('active', active);
  info.classList.toggle('warn', tooShort);
  if (active) {
    info.textContent = `循环中 ${fmt(loop.in)} → ${fmt(loop.out)}（时长 ${fmt(loop.out - loop.in)}）`;
  } else if (tooShort) {
    info.textContent = `区间仅 ${fmt(loop.out - loop.in)}，至少需要 0.5 秒`;
  } else if (both) {
    info.textContent = `已设置 ${fmt(loop.in)} → ${fmt(loop.out)}，勾选「片段循环」启用`;
  } else if (loop.in !== null) {
    info.textContent = `入点 ${fmt(loop.in)}，请继续设置出点`;
  } else if (loop.out !== null) {
    info.textContent = `出点 ${fmt(loop.out)}（入点默认 0:00.0），请继续设置入点`;
  } else {
    info.textContent = '未设置循环区间';
  }
}

// ---------------------------------------------------------------------------
// 电平匹配（可选）：消除 A/B 响度差造成的盲测线索
// ---------------------------------------------------------------------------

const RMS_MIN = 1e-6;        // RMS 下限，低于此值视为无声
const GAIN_MIN_DB = -24;     // 衰减下限（dB）

/** 统一时间轴内、汇总各声道样本的 RMS */
function computeRms(buf, seconds) {
  const len = Math.min(buf.length, Math.floor(seconds * buf.sampleRate));
  if (len <= 0) return NaN;
  let sum = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) sum += data[i] * data[i];
  }
  return Math.sqrt(sum / (len * buf.numberOfChannels));
}

const validRms = (r) => Number.isFinite(r) && r >= RMS_MIN;

/** 由 RMS 重算各音源调整量（dB）：以较安静音源为基准，仅衰减较响者 */
function refreshLevelMatch() {
  // A 或 B 的 RMS 无效（< 1e-6 或非有限值）时不做匹配，全部保持 0 dB
  levelRef = validRms(rms.A) && validRms(rms.B) ? Math.min(rms.A, rms.B) : null;
  for (const k of ['A', 'B', 'X']) {
    let db = 0;
    if (levelRef !== null && validRms(rms[k])) {
      db = 20 * Math.log10(levelRef / rms[k]);
      db = Math.max(GAIN_MIN_DB, Math.min(0, db)); // 衰减限制在 -24～0 dB
    }
    gainDb[k] = db;
  }
  applyGains();
  renderLevelInfo();
}

/** 按开关状态把调整量写入 GainNode；不打断播放，关闭立即恢复原始电平 */
function applyGains() {
  if (!actx) return;
  for (const k of ['A', 'B', 'X']) {
    if (gains[k]) {
      gains[k].gain.value = Math.pow(10, (levelMatchOn ? gainDb[k] : 0) / 20);
    }
  }
}

function renderLevelInfo() {
  const fmtDb = (db) => {
    const s = db.toFixed(1);
    return s === '-0.0' ? '0.0' : s;
  };
  const el = $('#levelInfo');
  el.textContent = `A ${fmtDb(gainDb.A)} dB · B ${fmtDb(gainDb.B)} dB`;
  el.classList.toggle('off', !levelMatchOn);
}

// ---------------------------------------------------------------------------
// 音频加载
// ---------------------------------------------------------------------------

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('音频加载失败');
  const raw = await res.arrayBuffer();
  return actx.decodeAudioData(raw);
}

async function loadTrial(n) {
  currentTrial = n;
  saveRecovery(); // 记住当前题号，刷新后可回到本题
  if (!xCache.has(n)) {
    const buf = await fetchBuffer(`/api/session/${session.id}/trial/${n}/x`);
    // 每题 X 与 A/B 按同一规则计算 RMS（统一时间轴内、汇总各声道）
    xCache.set(n, { buf, rms: computeRms(buf, timeline) });
  }
  const cached = xCache.get(n);
  buffers.X = cached.buf;
  rms.X = cached.rms;
  refreshLevelMatch(); // X 的调整量随题更新
  // 若当前正在听 X，无缝换成本题的 X（保持位置与播放状态）
  if (currentSrc === 'X') {
    const pos = position();
    const wasPlaying = playing;
    stopSource();
    playing = false;
    startOffset = pos;
    if (wasPlaying) play();
  }
  renderTrial();
}

// ---------------------------------------------------------------------------
// UI 渲染
// ---------------------------------------------------------------------------

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function updatePlayBtn() {
  $('#btnPlay').textContent = playing ? '⏸ 暂停' : '▶ 播放';
}

function updateTransport() {
  $('#seek').value = position();
  $('#timeLabel').textContent = `${fmt(position())} / ${fmt(timeline)}`;
}

function updateSrcButtons() {
  document.querySelectorAll('.src-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.src === currentSrc);
  });
}

function renderTrial() {
  $('#trialLabel').textContent = `第 ${currentTrial + 1} / ${session.numTrials} 题`;
  $('#btnPrev').disabled = currentTrial === 0;
  $('#btnNext').disabled = currentTrial === session.numTrials - 1;

  const ans = answers[currentTrial];
  $('#btnAnsA').classList.toggle('selected', ans === 'A');
  $('#btnAnsB').classList.toggle('selected', ans === 'B');

  // 进度圆点
  const progress = $('#progress');
  progress.innerHTML = '';
  for (let i = 0; i < session.numTrials; i++) {
    const dot = document.createElement('button');
    dot.className = 'dot';
    if (answers[i]) dot.classList.add('done');
    if (i === currentTrial) dot.classList.add('current');
    dot.textContent = i + 1;
    dot.addEventListener('click', () => loadTrial(i));
    progress.appendChild(dot);
  }

  const allAnswered = answers.every(Boolean);
  $('#btnSubmit').disabled = !allAnswered;
  $('#btnSubmit').textContent = allAnswered
    ? '提交并揭晓答案'
    : `提交并揭晓答案（还剩 ${answers.filter((a) => !a).length} 题未答）`;
}

function tick() {
  if (playing) updateTransport();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

/** 进入测试视图：解码 A/B、初始化播放状态并加载当前题（新建与恢复共用） */
async function enterTest() {
  // AudioContext 需在用户手势中创建
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  await actx.resume();

  // 每个音源一个 GainNode（电平匹配用），只创建一次
  if (!gains.A) {
    for (const k of ['A', 'B', 'X']) {
      gains[k] = actx.createGain();
      gains[k].connect(actx.destination);
    }
  }

  buffers.A = await fetchBuffer(`/api/session/${session.id}/audio/A`);
  buffers.B = await fetchBuffer(`/api/session/${session.id}/audio/B`);
  // 统一时间轴：以较短时长为准
  timeline = Math.min(buffers.A.duration, buffers.B.duration);
  $('#seek').max = timeline;

  // 新一轮测试：清空旧的循环区间（区间不得越过新音频的有效时长）
  loop.in = null;
  loop.out = null;
  loop.on = false;
  renderLoopUI();

  // 电平匹配：解码后在统一时间轴内汇总各声道样本计算 RMS
  rms.A = computeRms(buffers.A, timeline);
  rms.B = computeRms(buffers.B, timeline);
  rms.X = NaN; // 待 loadTrial 解码本题 X 后计算
  levelMatchOn = $('#chkLevelMatch').checked;
  refreshLevelMatch();

  currentSrc = 'A';
  playing = false;
  startOffset = 0;
  updateSrcButtons();
  updatePlayBtn();
  updateTransport();

  await loadTrial(currentTrial);
  show('view-test');
}

$('#btnStart').addEventListener('click', async () => {
  const errEl = $('#uploadError');
  errEl.textContent = '';
  const fa = $('#fileA').files[0];
  const fb = $('#fileB').files[0];
  if (!fa || !fb) {
    errEl.textContent = '请同时选择音频 A 和音频 B';
    return;
  }

  const btn = $('#btnStart');
  btn.disabled = true;
  btn.textContent = '上传并解码中…';
  try {
    // 开始新测试即放弃旧的待恢复会话（主动删除，恢复标识随之失效）
    if (pendingResume) {
      await fetch(`/api/session/${pendingResume.id}`, { method: 'DELETE' }).catch(() => {});
      pendingResume = null;
      $('#view-resume').classList.add('hidden');
    }

    const fd = new FormData();
    fd.append('a', fa);
    fd.append('b', fb);
    fd.append('numTrials', $('#numTrials').value);
    const res = await fetch('/api/session', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '创建会话失败');

    session = data;
    answers = Array(data.numTrials).fill(null);
    currentTrial = 0;
    xCache.clear();
    saveRecovery(); // 保存恢复标识，刷新/重开页面可找回本会话

    await enterTest();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始测试';
  }
});

// ---------------------------------------------------------------------------
// 会话恢复（刷新 / 重新打开页面后找回未提交的测试）
// ---------------------------------------------------------------------------

async function initRecovery() {
  const saved = loadSavedRecovery();
  if (!saved) return;
  try {
    const res = await fetch('/api/session/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: saved.token }),
    });
    if (!res.ok) throw new Error('recover failed');
    const data = await res.json();
    pendingResume = {
      ...data,
      token: saved.token,
      trial: Math.min(Math.max(0, saved.trial | 0), data.numTrials - 1),
    };
    const answered = data.answers.filter(Boolean).length;
    $('#resumeInfo').textContent =
      `检测到本机有未提交的测试：共 ${data.numTrials} 题，已答 ${answered} 题，` +
      `上次进行到第 ${pendingResume.trial + 1} 题。`;
    $('#view-resume').classList.remove('hidden');
  } catch (_) {
    clearRecovery(); // 会话已提交、删除或过期，恢复标识不再有效
  }
}

$('#btnResume').addEventListener('click', async () => {
  if (!pendingResume) return;
  const btn = $('#btnResume');
  btn.disabled = true;
  btn.textContent = '正在恢复…';
  const resume = pendingResume;
  try {
    session = {
      id: resume.id,
      numTrials: resume.numTrials,
      recoveryToken: resume.token,
    };
    answers = resume.answers.slice();
    currentTrial = resume.trial;
    xCache.clear();
    await enterTest();
    pendingResume = null;
    $('#view-resume').classList.add('hidden');
  } catch (e) {
    alert(e.message || '恢复失败');
    btn.disabled = false;
    btn.textContent = '继续上次测试';
  }
});

$('#btnDiscardResume').addEventListener('click', async () => {
  if (pendingResume) {
    await fetch(`/api/session/${pendingResume.id}`, { method: 'DELETE' }).catch(() => {});
  }
  pendingResume = null;
  clearRecovery();
  $('#view-resume').classList.add('hidden');
});

$('#btnPlay').addEventListener('click', async () => {
  await actx.resume();
  if (playing) pause();
  else play();
});

document.querySelectorAll('.src-btn').forEach((b) => {
  b.addEventListener('click', () => switchSource(b.dataset.src));
});

$('#seek').addEventListener('input', (e) => seekTo(parseFloat(e.target.value)));

// 片段循环：设置 / 清除均不改变当前播放或暂停状态
$('#btnLoopIn').addEventListener('click', () => setLoopPoint('in'));
$('#btnLoopOut').addEventListener('click', () => setLoopPoint('out'));
$('#btnLoopClear').addEventListener('click', clearLoop);
$('#chkLoop').addEventListener('change', (e) => setLoopEnabled(e.target.checked));

// 电平匹配开关：只改 GainNode 增益，播放位置与播放/暂停状态不受影响
$('#chkLevelMatch').addEventListener('change', (e) => {
  levelMatchOn = e.target.checked;
  applyGains(); // 关闭后立即恢复原始电平
  renderLevelInfo();
});

$('#btnPrev').addEventListener('click', () => { if (currentTrial > 0) loadTrial(currentTrial - 1); });
$('#btnNext').addEventListener('click', () => { if (currentTrial < session.numTrials - 1) loadTrial(currentTrial + 1); });

async function sendAnswer(val) {
  answers[currentTrial] = val;
  renderTrial();
  const res = await fetch(`/api/session/${session.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trial: currentTrial, answer: val }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '答案保存失败');
  }
}

$('#btnAnsA').addEventListener('click', () => sendAnswer('A'));
$('#btnAnsB').addEventListener('click', () => sendAnswer('B'));

$('#btnSubmit').addEventListener('click', async () => {
  if (!confirm('提交后将一次性揭晓全部答案，且不可再修改。确定提交？')) return;
  const res = await fetch(`/api/session/${session.id}/submit`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '提交失败');
    return;
  }
  pause();
  clearRecovery(); // 提交后恢复标识立即失效（服务端同步作废）
  showResults(data.results);
});

$('#btnAgain').addEventListener('click', async () => {
  pause();
  if (session) {
    await fetch(`/api/session/${session.id}`, { method: 'DELETE' }).catch(() => {});
  }
  session = null;
  answers = [];
  xCache.clear();
  clearRecovery();
  buffers.A = buffers.B = buffers.X = null;
  rms.A = rms.B = rms.X = NaN;
  refreshLevelMatch(); // 清空调整量显示，增益归零
  currentSrc = 'A';
  startOffset = 0;
  $('#fileA').value = '';
  $('#fileB').value = '';
  show('view-upload');
});

// ---------------------------------------------------------------------------
// 结果展示
// ---------------------------------------------------------------------------

function showResults(results) {
  const pct = (results.accuracy * 100).toFixed(1);
  $('#scoreLabel').textContent =
    `答对 ${results.correct} / ${results.total} 题，正确率 ${pct}%`;

  const tbody = $('#resultTable tbody');
  tbody.innerHTML = '';
  for (const d of results.detail) {
    const tr = document.createElement('tr');
    tr.className = d.correct ? 'right' : 'wrong';
    tr.innerHTML =
      `<td>${d.trial}</td><td>${d.x}</td><td>${d.answer}</td>` +
      `<td>${d.correct ? '✓ 正确' : '✗ 错误'}</td>`;
    tbody.appendChild(tr);
  }
  show('view-result');
}

// 启动 UI 刷新循环，并探测本机是否有可恢复的未提交会话
tick();
initRecovery();
