// ============================================================
//  app.js ― プログラム本体（教員は触らなくてOK）
//  内容はすべて config.js から読み込みます
// ============================================================
import { connect } from 'MP_SDK';
import { SETTINGS, BUILDINGS as LOCAL_BUILDINGS } from './config.js';
import * as CONFIG_ALL from './config.js';
const SIGNS = CONFIG_ALL.SIGNS || {};   // 案内パネル画像の設定（無ければ何も出さない）

// ---------- 設定の読み込み ----------
// config.js の useSheet が true なら、スプレッドシートから読む。
// 読めなかったときは config.js の内容を使う。
let BUILDINGS = LOCAL_BUILDINGS;
let configNotice = "";
if (SETTINGS.useSheet) {
  try {
    const res = await fetch(SETTINGS.gasUrl + "?action=config&t=" + Date.now());
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    if (!json.buildings || Object.keys(json.buildings).length === 0) {
      throw new Error("建物が1つも読み込めませんでした");
    }
    BUILDINGS = json.buildings;
    console.log("設定をスプレッドシートから読み込みました");
  } catch (e) {
    console.error("スプレッドシートの設定を読めませんでした:", e);
    configNotice = "スプレッドシートの設定を読めなかったため、config.js の内容を使っています（" + e.message + "）";
  }
}

const $ = (id) => document.getElementById(id);
const LETTERS = ["A", "B", "C", "D"];

// 記述式の答え合わせ用：全角/半角・大文字/小文字・空白の違いを無視する
function normalizeText(s) {
  return String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
function textAnswers(q) {
  return (q.answers || (q.answer ? [q.answer] : [])).map(String);
}

// ---------- URLから建物・時期・編集モードを決める ----------
const params = new URLSearchParams(location.search);
const buildingId = params.get("building") || Object.keys(BUILDINGS)[0];
const building = BUILDINGS[buildingId];
const EDIT_MODE = params.get("edit") === "1";

// ---------- 状態 ----------
let studentInfo = { studentName: "", studentId: "" };
let mpSdk = null;
let currentPeriod = null;
let loadToken = 0;              // 時期を素早く切り替えたときの取り違え防止

// メインクイズの状態
let questions = [];
let currentQuestion = 0;
let correctCount = 0;
let answerResults = [];
let detailedAnswers = [];

// ============================================================
//  設定のチェック（書き間違いを画面に出す）
// ============================================================
function checkQuizList(list, where, warnings) {
  (list || []).forEach((q, i) => {
    const no = where + " 第" + (i + 1) + "問: ";
    if (!q.question) warnings.push(no + "question が空です");
    if (q.type === "text") {
      if (textAnswers(q).length === 0) warnings.push(no + "記述問題には answers（正解の候補）が必要です");
      return;
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      warnings.push(no + "options は2〜4個にしてください");
      return;
    }
    const valid = LETTERS.slice(0, q.options.length);
    if (!valid.includes(q.answer)) {
      warnings.push(no + "answer は " + valid.join("・") + " のどれかにしてください");
    }
  });
}

function validateBuilding(b) {
  const w = [];
  if (!Array.isArray(b.periods) || b.periods.length === 0) {
    w.push("periods が空です");
    return w;
  }
  const ids = new Set();
  b.periods.forEach((p) => {
    const pn = p.name || p.id || "(名前なしの期)";
    if (!p.id) w.push(pn + ": id がありません");
    if (ids.has(p.id)) w.push(pn + ": id「" + p.id + "」が他の期と重なっています");
    ids.add(p.id);
    if (!/^https?:\/\//.test(p.modelUrl || "")) w.push(pn + ": modelUrl が正しいアドレスではありません");
    checkQuizList(p.quiz, pn + " のメインクイズ", w);
    (p.tags || []).forEach((t, i) => {
      const tn = pn + " のタグ「" + (t.label || (i + 1) + "番目") + "」";
      ["x", "y", "z"].forEach((k) => {
        if (typeof t[k] !== "number") w.push(tn + ": " + k + " が数字ではありません");
      });
      checkQuizList(t.quiz, tn + " のクイズ", w);
    });
  });
  return w;
}

// ============================================================
//  回答の送信（Google Apps Script へ）
// ============================================================
function postResults(quizType, answers) {
  if (!SETTINGS.gasUrl || !answers.length) return;
  const payload = {
    studentName: studentInfo.studentName,
    studentId: studentInfo.studentId,
    quizType: quizType,
    buildingId: buildingId,
    buildingName: building.name,
    periodId: currentPeriod ? currentPeriod.id : "",
    periodName: currentPeriod ? currentPeriod.name : "",
    answers: answers
  };
  fetch(SETTINGS.gasUrl, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  }).catch((e) => console.error("クイズ結果の送信エラー:", e));
}

// 送信したら空にする（二重送信防止）
function sendMainResults() {
  if (detailedAnswers.length === 0) return;
  postResults("メイン画面", detailedAnswers);
  detailedAnswers = [];
}

// ============================================================
//  メインクイズ
// ============================================================
// ---------- 制限時間（クイズ全体）----------
const quizTimerEl = document.createElement("div");
quizTimerEl.style.cssText = "display:none; font-size:18px; font-weight:bold; margin:0 0 8px;";
$("quiz").insertBefore(quizTimerEl, $("question"));
let quizTimerId = null;
let questionAnswered = false;   // いまの問題に回答済みか

function stopQuizTimer() {
  if (quizTimerId) { clearInterval(quizTimerId); quizTimerId = null; }
  quizTimerEl.style.display = "none";
}

function startQuizTimer() {
  stopQuizTimer();
  const limit = Number(currentPeriod && currentPeriod.quizTimeLimit);
  if (!(limit > 0)) return;            // 設定がなければ時間無制限
  let left = limit;
  const draw = () => {
    const m = Math.floor(left / 60);
    const sec = String(left % 60).padStart(2, "0");
    quizTimerEl.textContent = "⏱ 残り " + m + ":" + sec;
    quizTimerEl.style.color = left <= 10 ? "#c00" : "#222";
  };
  quizTimerEl.style.display = "block";
  draw();
  quizTimerId = setInterval(() => {
    left--;
    if (left <= 0) timeUp();
    else draw();
  }, 1000);
}

// 時間切れ：まだ解いていない問題はすべて×にして、結果画面を出す
function timeUp() {
  stopQuizTimer();
  const from = questionAnswered ? currentQuestion + 1 : currentQuestion;
  for (let i = from; i < questions.length; i++) {
    const q = questions[i];
    answerResults.push("×");
    detailedAnswers.push({
      questionText: q.question,
      selectedAnswer: "（時間切れ・未回答）",
      correctAnswer: q.options[LETTERS.indexOf(q.answer)],
      isCorrect: false
    });
  }
  finishTest(true);
}

function showQuestion() {
  const q = questions[currentQuestion];
  $("question").textContent = "Q. " + q.question;

  const box = $("answers");
  box.innerHTML = "";
  box.style.display = "block";
  q.options.forEach((opt, i) => {
    const b = document.createElement("button");
    b.textContent = LETTERS[i] + "：" + opt;
    b.addEventListener("click", () => answer(i));
    box.appendChild(b);
  });

  $("result").textContent = "";
  $("nextChoice").style.display = "none";
  $("explanationButton").style.display = q.sweepId ? "block" : "none";
  questionAnswered = false;
}

function answer(selected) {
  questionAnswered = true;
  const q = questions[currentQuestion];
  const correctIndex = LETTERS.indexOf(q.answer);
  const isCorrect = selected === correctIndex;

  if (isCorrect) {
    $("result").textContent = "正解！🎉";
    correctCount++;
    answerResults.push("○");
  } else {
    $("result").textContent = "不正解！";
    answerResults.push("×");
  }

  detailedAnswers.push({
    questionText: q.question,
    selectedAnswer: q.options[selected],
    correctAnswer: q.options[correctIndex],
    isCorrect: isCorrect
  });

  $("answers").style.display = "none";
  $("nextChoice").style.display = "block";
}

$("nextQuestionButton").addEventListener("click", () => {
  currentQuestion++;
  if (currentQuestion < questions.length) {
    showQuestion();
  } else {
    stopQuizTimer();
    $("question").textContent = "クイズ終了！";
    $("answers").style.display = "none";
    $("result").textContent = "";
    $("nextChoice").style.display = "none";
  }
});

$("explanationButton").addEventListener("click", () => {
  const q = questions[currentQuestion];
  if (mpSdk && q && q.sweepId) {
    mpSdk.Sweep.moveTo(q.sweepId, {}).catch((e) => console.error("移動エラー:", e));
  }
});

$("testButton").addEventListener("click", () => {
  if (questions.length === 0) return;
  currentQuestion = 0;
  correctCount = 0;
  answerResults = [];
  detailedAnswers = [];
  $("quiz").style.display = "block";
  showQuestion();
  startQuizTimer();
});

function finishTest(timedOut) {
  stopQuizTimer();
  $("quiz").style.display = "none";

  const total = answerResults.length;
  const accuracy = total > 0 ? (correctCount / total) * 100 : 0;

  $("score").textContent = "正解数　" + correctCount + " / " + total + "問";
  $("accuracy").textContent = "正答率　" + accuracy.toFixed(1) + "%";

  const area = $("answerResults");
  area.innerHTML = "";
  if (timedOut) {
    const note = document.createElement("p");
    note.textContent = "⏰ 時間切れのため終了しました（未回答の問題は×です）";
    note.style.color = "#c00";
    area.appendChild(note);
  }
  answerResults.forEach((r, i) => {
    const p = document.createElement("p");
    p.textContent = "第" + (i + 1) + "問　" + r;
    area.appendChild(p);
  });

  sendMainResults();
  $("resultScreen").style.display = "block";
}

$("endTestButton").addEventListener("click", () => finishTest(false));

$("closeResultButton").addEventListener("click", () => {
  $("resultScreen").style.display = "none";
});

// ============================================================
//  ◇メニュー
// ============================================================
$("menuButton").addEventListener("click", () => {
  $("quizMenu").classList.toggle("open");
});

// ============================================================
//  読み込み中・エラー表示
// ============================================================
function showOverlay(text, isError) {
  const el = $("loading");
  el.textContent = text + (isError ? "（クリックで閉じる）" : "");
  el.dataset.error = isError ? "1" : "";
  el.style.display = "flex";
}
function hideOverlay() {
  $("loading").style.display = "none";
}
$("loading").addEventListener("click", () => {
  if ($("loading").dataset.error === "1") hideOverlay();
});

// ============================================================
//  タグのパネル（画像／動画／クイズ）
//  Matterportのサンドボックスの中ではYouTubeが動かないため、
//  パネルは自前で作り、タグが選ばれたときに表示する。
//  上部のタブ（画像・動画・クイズ）は常に表示される。
// ============================================================
const PANEL_W = 300;   // 最初のファイルと同じ横幅   // パネルの大きさ(px)。画像・動画・クイズで共通
const DOCK_W = 360;   // Dock したときの横幅（高さは画面いっぱい）
const PANEL_H = 380;   // 説明文と16:9の動画が入る高さ（最初のファイルは300）

(function injectPanelStyle() {
  const st = document.createElement("style");
  st.textContent = `
  #tagPanel { display:none; position:absolute; top:15px; right:20px; z-index:1800;
    width:${PANEL_W}px; height:${PANEL_H}px; box-sizing:border-box; padding:14px;
    background:#000; color:#fff; border-radius:10px; font-family:sans-serif; flex-direction:column; }
  #tagPanel button { cursor:pointer; font-size:14px; padding:5px 10px; }
  /* Dock：3D画面を左に縮めて、右側に白いパネルを固定する */
  #matterportContainer.dockedMode #showcase-iframe { width:calc(100% - ${DOCK_W}px); }
  #tagPanel.docked { top:0; right:0; width:${DOCK_W}px; height:100%; border-radius:0; background:#fff; color:#222; }
  #tagPanel.docked .tpDesc { max-height:35%; border-top-color:#ccc; }
  #tagPanel.docked .tpTabs button.active { background:#222; color:#fff; }
  #tagPanel.docked .tpMsg { color:#c60; }
  #tagPanel .tpDockBtn { background:none; border:0; padding:4px 6px; color:#fff; display:flex; align-items:center; }
  #tagPanel .tpDockBtn:hover, #tagPanel.docked .tpDockBtn { color:#e0526e; }
  #tagPanel .tpNav { display:none; align-items:center; gap:6px; font-size:14px; }
  #tagPanel.docked .tpNav { display:flex; }
  #tagPanel .tpNav button { background:none; border:0; font-size:20px; line-height:1; padding:0 6px; color:inherit; }
  #tagPanel .tpHeadBtns { display:flex; gap:6px; }
  #tagPanel .tpHead { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0; }
  #tagPanel .tpTitle { font-size:16px; font-weight:bold; }
  #tagPanel .tpTabs { display:flex; gap:5px; margin-bottom:12px; flex-shrink:0; }
  #tagPanel .tpTabs button { font-size:13.3333px; padding:1px 6px; }
  #tagPanel .tpTabs button.active { background:#fff; color:#000; font-weight:bold; }
  #tagPanel .tpBody { flex:1; min-height:0; position:relative; display:flex; flex-direction:column; }
  #tagPanel .tpDesc { flex-shrink:0; max-height:96px; overflow-y:auto; margin-top:12px;
    padding:14px 4px; border-top:1px solid #555; font-size:14.5px; line-height:1.8; white-space:pre-wrap; }
  #tagPanel .tpImgBox { position:relative; flex:1; min-height:0; width:100%; overflow:hidden; }
  #tagPanel .tpImgBox img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
  #tagPanel .tpRow { display:flex; justify-content:space-between; align-items:center; margin-top:8px; flex-shrink:0; font-size:14px; }
  #tagPanel .tpMsg { font-size:13px; color:#f90; margin:6px 0 0; }
  #tagPanel .tpVideo { width:100%; aspect-ratio:16/9; border:0; display:block; background:#111; }
  #tagPanel .tpQuiz { overflow-y:auto; font-size:14px; line-height:1.6; padding:4px 8px 8px 4px; }
  #tagPanel .tpQuiz h3 { font-size:16px; margin:8px 0; }
  #tagPanel .tpQuiz p.q { font-size:14.5px; margin:0 0 10px; }
  #tagPanel .tpQuiz label { display:block; font-size:14px; margin:10px 0; }
  #tagPanel .tpQuiz .foot { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:14px; }
  #tagPanel .tpQuiz .res { font-size:18px; font-weight:bold; flex:1; }
  `;
  document.head.appendChild(st);
})();

const tagPanel = document.createElement("div");
tagPanel.id = "tagPanel";
$("matterportContainer").appendChild(tagPanel);

let panelTagId = null;
let panelTagList = [];      // いまの時期のタグID（config.jsの並び順）
let panelTagMap = {};
let panelPeriod = null;
let panelDocked = false;    // Dock（画面の右側に固定）しているか
let panelSdk = null;

function mk(tagName, className, text) {
  const e = document.createElement(tagName);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Dock中は3D画面を縮めて、パネルを右側に固定する（パネルが閉じているときは元の大きさ）
function applyDock() {
  const on = panelDocked && panelTagId !== null;
  tagPanel.classList.toggle("docked", on);
  $("matterportContainer").classList.toggle("dockedMode", on);
}

// タグの場所へ移動して、そのタグの詳細パネルを開く
function openTagById(id, t, period) {
  try {
    const p = panelSdk.Mattertag.navigateToTag(id, panelSdk.Mattertag.Transition.FLY, true);
    if (p && p.catch) p.catch((e) => console.error("タグへの移動エラー:", e));
  } catch (e) {
    console.error("タグへの移動エラー:", e);
  }
  openTagPanel(id, t, period);
}

// 「‹ 1 of 6 ›」：前後のタグへ移動してパネルを切り替える（最後の次は最初に戻る）
function gotoTag(delta) {
  const n = panelTagList.length;
  if (n < 2 || panelTagId === null) return;
  const i = panelTagList.indexOf(panelTagId);
  const id = panelTagList[(i + delta + n) % n];
  openTagById(id, panelTagMap[id], panelPeriod);
}

function closeTagPanel(alsoCloseTag) {
  const id = panelTagId;
  panelTagId = null;
  applyDock();
  tagPanel.style.display = "none";
  tagPanel.innerHTML = "";            // 動画のiframeも消えるので再生が止まる
  if (alsoCloseTag && id && panelSdk && panelSdk.Tag.close) {
    panelSdk.Tag.close(id).catch(() => {});
  }
}

function openTagPanel(tagId, t, period) {
  tagPanel.innerHTML = "";
  panelTagId = tagId;

  const images = t.images || [];
  const quiz = t.quiz || [];
  const vid = t.videoId || period.videoId || building.videoId || "";

  // ---- ヘッダー ----
  const head = mk("div", "tpHead");
  head.appendChild(mk("span", "tpTitle", t.label || ""));
  if (panelTagList.length >= 2) {
    const nav = mk("div", "tpNav");
    const prev = mk("button", "", "‹");
    const next = mk("button", "", "›");
    prev.title = "前のタグ";
    next.title = "次のタグ";
    prev.addEventListener("click", () => gotoTag(-1));
    next.addEventListener("click", () => gotoTag(1));
    nav.append(prev, mk("span", "", (panelTagList.indexOf(tagId) + 1) + " of " + panelTagList.length), next);
    head.appendChild(nav);
  }
  const btns = mk("div", "tpHeadBtns");
  const dockBtn = mk("button", "tpDockBtn", "");
  dockBtn.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">' +
    '<rect x="2" y="3" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2"/>' +
    '<rect x="12.5" y="7" width="4" height="8" rx="1" fill="currentColor"/></svg>';
  dockBtn.title = panelDocked ? "Undock" : "Dock";
  dockBtn.addEventListener("click", () => {
    panelDocked = !panelDocked;
    dockBtn.title = panelDocked ? "Undock" : "Dock";
    applyDock();
  });
  const x = mk("button", "", "✕");
  x.addEventListener("click", () => closeTagPanel(true));
  btns.append(dockBtn, x);
  head.appendChild(btns);
  applyDock();
  tagPanel.appendChild(head);

  const tabsBar = mk("div", "tpTabs");
  tagPanel.appendChild(tabsBar);
  const body = mk("div", "tpBody");
  tagPanel.appendChild(body);
  if (t.description) tagPanel.appendChild(mk("div", "tpDesc", t.description));   // 画像・動画・クイズの下

  // ---- 画像 ----
  let gi = 0;
  function renderImages() {
    const box = mk("div", "tpImgBox");
    const img = document.createElement("img");
    img.alt = "";
    const msg = mk("p", "tpMsg", "");
    img.onerror = () => { msg.textContent = "画像を読み込めません"; };
    img.onload = () => { msg.textContent = ""; };
    box.appendChild(img);
    body.appendChild(box);
    body.appendChild(msg);

    const row = mk("div", "tpRow");
    const prev = mk("button", "", "前へ");
    const count = mk("span", "", "");
    const next = mk("button", "", "次へ");
    row.append(prev, count, next);
    if (images.length >= 2) body.appendChild(row);

    function update() {
      img.src = images[gi];
      count.textContent = (gi + 1) + " / " + images.length;
    }
    prev.addEventListener("click", () => { gi = (gi - 1 + images.length) % images.length; update(); });
    next.addEventListener("click", () => { gi = (gi + 1) % images.length; update(); });
    update();
  }

  // ---- 動画（サンドボックスの外なのでYouTubeが再生できる）----
  function renderVideo() {
    const f = document.createElement("iframe");
    f.className = "tpVideo";
    f.title = "解説動画";
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    f.allowFullscreen = true;
    // modestbranding: YouTubeロゴを控えめに / rel=0: 終了後に他チャンネルの動画を出さない
    // iv_load_policy=3: 注釈を出さない / playsinline: その場で再生
    f.src = "https://www.youtube.com/embed/" + encodeURIComponent(vid) +
            "?rel=0&modestbranding=1&iv_load_policy=3&playsinline=1";
    body.appendChild(f);
  }

  // ---- クイズ（タブを行き来しても途中経過が残る）----
  const qs = { cq: 0, score: 0, answered: false, picked: -1, finished: false, sent: false, detailed: [], note: "", scroll: 0, text: "" };
  function renderQuiz() {
    const wrap = mk("div", "tpQuiz");
    wrap.style.flex = "1";
    body.appendChild(wrap);
    // スクロール位置を覚えておく（「回答する」で描き直しても位置を戻すため）
    wrap.addEventListener("scroll", () => { qs.scroll = wrap.scrollTop; });
    wrap.appendChild(mk("h3", "", "クイズ"));

    if (qs.finished) {
      wrap.appendChild(mk("p", "q", "クイズ終了！"));
      wrap.appendChild(mk("div", "res", quiz.length + "問中 " + qs.score + " 問正解！"));
      return;
    }

    const q = quiz[qs.cq];
    wrap.appendChild(mk("p", "q", q.question));

    const isText = q.type === "text";
    const corIdx = isText ? -1 : LETTERS.indexOf(q.answer);
    let textInput = null;
    if (isText) {
      textInput = document.createElement("input");
      textInput.type = "text";
      textInput.placeholder = "答えを入力してください";
      textInput.value = qs.text;
      textInput.disabled = qs.answered;
      textInput.style.cssText = "display:block; width:100%; box-sizing:border-box; padding:8px; margin:10px 0; font-size:14px;";
      textInput.addEventListener("input", () => { qs.text = textInput.value; qs.note = ""; });
      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && !qs.answered) check.click();
      });
      wrap.appendChild(textInput);
    }
    (isText ? [] : q.options).forEach((opt, i) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "tpQuizAnswer";
      input.checked = (qs.picked === i);
      input.disabled = qs.answered;
      input.addEventListener("change", () => { qs.picked = i; qs.note = ""; });
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + LETTERS[i] + ". " + opt));
      wrap.appendChild(label);
    });

    const check = mk("button", "", "回答する");
    check.style.display = qs.answered ? "none" : "inline-block";
    wrap.appendChild(check);

    const foot = mk("div", "foot");
    const res = mk("div", "res", qs.note);
    const nextBtn = mk("button", "", (qs.cq === quiz.length - 1) ? "結果を見る" : "次の問題へ");
    nextBtn.style.display = qs.answered ? "inline-block" : "none";
    foot.append(res, nextBtn);
    wrap.appendChild(foot);
    wrap.scrollTop = qs.scroll;   // 回答しても、見ていた位置のまま

    check.addEventListener("click", () => {
      if (qs.answered) return;
      let ok, selectedText, correctText;
      if (isText) {
        const typed = qs.text.trim();
        if (!typed) { res.textContent = "答えを入力してね！"; return; }
        const list = textAnswers(q);
        ok = list.some((a) => normalizeText(a) === normalizeText(typed));
        selectedText = typed;
        correctText = list[0];
      } else {
        if (qs.picked < 0) { res.textContent = "選択肢を選んでね！"; return; }
        ok = qs.picked === corIdx;
        selectedText = q.options[qs.picked];
        correctText = q.options[corIdx];
      }
      qs.answered = true;
      qs.detailed.push({
        questionText: q.question,
        selectedAnswer: selectedText,
        correctAnswer: correctText,
        isCorrect: ok
      });
      if (ok) qs.score++;
      qs.note = ok ? "正解！🎉" : (isText ? "不正解！ 正解例：" + correctText : "不正解！");
      showTab("quiz");
    });

    nextBtn.addEventListener("click", () => {
      if (qs.cq < quiz.length - 1) {
        qs.cq++; qs.answered = false; qs.picked = -1; qs.text = ""; qs.note = ""; qs.scroll = 0;   // 次の問題は一番上から
           } else {
        qs.finished = true;

        // 丸いタグマークをピンク色にする
        if (quiz.length > 0 && panelSdk) {
          panelSdk.Tag.editColor(tagId, {
            r: 1.0,
            g: 0.45,
            b: 0.68
          }).catch((e) => {
            console.error("タグの色変更エラー:", e);
          });
        }

        // 同じタグのタイトルパネルもピンク色にする
        markTitlePanelCompleted(tagId);

  if (!qs.sent && qs.detailed.length) {
    qs.sent = true;
    postResults((t.label || "") + "パネル", qs.detailed);
  }
}
      showTab("quiz");
    });
  }

  // ---- タブ（画像・動画・クイズの順。中身があるものだけ）----
  const tabs = [];
  if (images.length) tabs.push({ key: "images", label: "画像", render: renderImages });
  if (vid)           tabs.push({ key: "video",  label: "動画", render: renderVideo });
  if (quiz.length)   tabs.push({ key: "quiz",   label: "クイズ", render: renderQuiz });

  const buttons = {};
  function showTab(key) {
    body.innerHTML = "";               // 動画タブから離れると、動画も止まる
    tabs.forEach((tb) => buttons[tb.key].classList.toggle("active", tb.key === key));
    tabs.find((tb) => tb.key === key).render();
  }
  tabs.forEach((tb) => {
    const b = mk("button", "", tb.label);
    b.addEventListener("click", () => showTab(tb.key));
    buttons[tb.key] = b;
    tabsBar.appendChild(b);
  });

  if (tabs.length === 0) { body.appendChild(mk("p", "", "表示できる内容がありません")); }
  else showTab(tabs[0].key);

  tagPanel.style.display = "flex";
}

// ============================================================
//  タグの追加（時期ごと）
// ============================================================
async function setupTags(sdk, period, token) {
  const failed = [];
  const tagMap = {};          // タグID → 設定
  const tagList = [];         // タグIDの並び順
  panelSdk = sdk;
  closeTagPanel(false);

  for (const t of (period.tags || [])) {
    if (token !== loadToken) return failed;
    try {
      const [tagId] = await sdk.Tag.add({
        label: t.label,
        description: "",   // 説明文は自作パネルの下部に表示する
        anchorPosition: { x: t.x, y: t.y, z: t.z },
        stemVector: t.stem || { x: 0, y: 0.3, z: 0 }
      });
      tagMap[tagId] = t;
      tagList.push(tagId);
      addTitlePanel(tagId, t, period);
      // Matterport標準の吹き出しは出さない（クリックでタグの場所へ移動はする）
      await sdk.Tag.allowAction(tagId, { navigating: true, opening: false, docking: false, sharing: false });
    } catch (e) {
      console.error("タグの追加エラー:", t.label, e);
      failed.push(t.label || "(名前なし)");
    }
  }

  panelTagList = tagList;
  panelTagMap = tagMap;
  panelPeriod = period;

  // タグをクリックしたらパネルを開く（閉じるのは「✕」、または別のタグをクリックしたとき）
  const onTag = (id) => {
    if (token !== loadToken || !tagMap[id]) return;
    if (panelTagId !== id) openTagPanel(id, tagMap[id], period);
  };
  sdk.on(sdk.Mattertag.Event.CLICK, onTag);

  // 念のため：標準の「選択」でも開けるようにしておく（開くだけで、閉じはしない）
  sdk.Tag.openTags.subscribe({
    onChanged(state) {
      const sel = state && state.selected ? Array.from(state.selected) : [];
      if (sel.length) onTag(sel[0]);
    }
  });

  return failed;
}

// ============================================================
//  タグのタイトルパネル（丸い印の上に、いつも表示される）
//  ・全タグに、タグ名のパネルが自動で付く（設定は不要）
//  ・パネルをクリックすると、そのタグの場所へ移動して詳細パネルが開く
//  ・config.js で画像に変えることもできる（下のSIGNS／titleImage）
//  3D上の位置を画面上の位置に変換して重ねるため、常に正面を向く。
// ============================================================
const SHOW_TAG_TITLES = true;   // false にすると、タイトルパネルを出さない
const TITLE_RISE = 0.15;        // 丸い印から、パネルの下端までの高さ(m)
const SIGN_REF_DIST = 3;        // この距離(m)のとき、画像が設定した幅になる／文字のパネルが等倍になる
const SIGN_MAX_DIST = 10;       // これより遠いと表示しない(m)
const SIGN_MIN_PX = 40;         // 画像の最小の幅(px)
const SIGN_MAX_PX = 420;        // 画像の最大の幅(px)
const SIGN_BEHIND_CHECK = true; // 背後のものを隠す。まったく出ないときは false にして試す
const SIGN_DEBUG = false;       // true にすると、Consoleに座標を出す（原因調べ用）

(function injectSignStyle() {
  const st = document.createElement("style");
  st.textContent = `
    /* タイトルパネル：通常時は青緑色 */
  .tagTitle {
    position:absolute;
    left:0;
    top:0;
    display:none;
    transform-origin:50% 100%;
    box-sizing:border-box;
    background:#fff;
    color:#20b8ca;
    border:4px solid #20b8ca;
    font:bold 22px sans-serif;
    padding:14px 26px;
    border-radius:0;
    box-shadow:0 2px 6px rgba(0,0,0,.2);
    white-space:nowrap;
    pointer-events:auto;
    cursor:pointer;
    user-select:none;
  }

  /* タイトルパネルの下向きの三角形 */
  .tagTitle::after {
    content:"";
    position:absolute;
    left:50%;
    bottom:-10px;
    margin-left:-8px;
    border:8px solid transparent;
    border-top-color:currentColor;
    border-bottom:0;
  }

  /* クイズ完了後：ピンク色 */
  .tagTitle.completed {
    color:#f48aa8;
    border-color:#f48aa8;
  }

  .tagTitle.img { padding:0; background:none; box-shadow:none; border-radius:0; }
  .tagTitle.img::after { display:none; }
  .tagTitle.img img { display:block; width:100%; }
    
     /* タグの見方を説明する案内板画像 */
  .guideBoard {
    position:absolute;
    display:none;
    width:320px;
    height:auto;
    border:none;
    box-shadow:none;
    pointer-events:none;
    object-fit:contain;
  }
    `;
  document.head.appendChild(st);
})();

const signLayer = document.createElement("div");
signLayer.style.cssText = "position:absolute; left:0; top:0; overflow:hidden; pointer-events:none; z-index:900;";
$("matterportContainer").appendChild(signLayer);

let signItems = [];
let signPose = null;
let signSdk = null;
let signDebugDone = false;

function clearSigns() {
  signLayer.innerHTML = "";
  signItems = [];
  signPose = null;
  signSdk = null;
  signDebugDone = false;
}

function updateSigns() {
  const frame = $("showcase-iframe");
  if (!signSdk || !signPose || !frame || !frame.clientWidth) return;
  const size = { w: frame.clientWidth, h: frame.clientHeight };
  signLayer.style.width = size.w + "px";      // Dock中は3D画面の幅に合わせる
  signLayer.style.height = size.h + "px";

  // ドールハウス・間取り図の表示では出さない
  const hideMode = /dollhouse|floorplan/.test(String(signPose.mode));

  for (const it of signItems) {
    if (it.el.dataset.broken) continue;      // 画像を読み込めなかったものは出さない
    let show = !hideMode;
    let c = null;
    let dist = 0;
    if (show) {
      c = signSdk.Conversion.worldToScreen(it.pos, signPose, size);
      const dx = it.pos.x - signPose.position.x;
      const dy = it.pos.y - signPose.position.y;
      const dz = it.pos.z - signPose.position.z;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (SIGN_DEBUG && !signDebugDone) {
        console.log("[タイトルパネル] 座標:", c, "距離:", dist.toFixed(2), "モード:", signPose.mode);
      }
      if (dist > SIGN_MAX_DIST || dist < 0.2) show = false;
      if (SIGN_BEHIND_CHECK && c.z > 1) show = false;               // カメラの背後
      if (c.x < -SIGN_MAX_PX || c.x > size.w + SIGN_MAX_PX ||
          c.y < -SIGN_MAX_PX || c.y > size.h + SIGN_MAX_PX) show = false;   // 画面の外
    }
    if (!show) { it.el.style.display = "none"; continue; }

    let scale = 1;
    if (it.kind === "image") {
      it.el.style.width = Math.max(SIGN_MIN_PX, Math.min(SIGN_MAX_PX, it.width * SIGN_REF_DIST / dist)) + "px";
    } else {
      scale = Math.max(0.7, Math.min(1.2, SIGN_REF_DIST / dist));     // 遠いと少し小さく
    }
    it.el.style.transform =
      "translate(" + c.x.toFixed(1) + "px," + c.y.toFixed(1) + "px) translate(-50%,-100%) scale(" + scale.toFixed(3) + ")";
    it.el.style.display = "block";
  }
  if (SIGN_DEBUG) signDebugDone = true;
}

// 位置・見た目が決まったパネルを1つ追加する
function pushSign(el, pos, kind, width, onClick, tagId) {
  if (onClick) el.addEventListener("click", onClick);
  signLayer.appendChild(el);
  signItems.push({
    el: el,
    pos: pos,
    kind: kind,
    width: width || 200,
    tagId: tagId || null
  });
}

// クイズを完了したタグのタイトルパネルをピンク色にする
function markTitlePanelCompleted(tagId) {
  const item = signItems.find((it) => it.tagId === tagId);

  if (item) {
    item.el.classList.add("completed");
  }
}

function makeImageSign(src, extraClass) {
  const box = document.createElement("div");
  box.className = "tagTitle img " + (extraClass || "");
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.onerror = () => { console.warn("パネルの画像を読み込めません:", src); box.style.display = "none"; box.dataset.broken = "1"; };
  img.src = src;
  box.appendChild(img);
  return box;
}

// タグの見方を説明する案内板を作成
function makeGuideBoard() {
  const board = document.createElement("img");

  board.className = "guideBoard";
  board.src = "./guide-board.png";
  board.alt = "VTのタグについての案内";

  return board;
}
  
// タグを追加できたら、その丸い印の上にタイトルパネルを付ける
function addTitlePanel(tagId, t, period) {
  if (!SHOW_TAG_TITLES || !signSdk) return;

  const stem = t.stem || { x: 0, y: 0.3, z: 0 };
  const pos = {
    x: t.x + stem.x,
    y: t.y + stem.y + TITLE_RISE,
    z: t.z + stem.z
  };

  const open = () => openTagById(tagId, t, period);

  if (t.titleImage) {
    pushSign(makeImageSign(t.titleImage), pos, "image", t.titleImageWidth || 160, open);
  } else {
    // タグの並び順から番号を取得
    const tagIndex = (period.tags || []).indexOf(t);

    // 丸数字（1〜20）
    const circledNumbers = [
      "①", "②", "③", "④", "⑤",
      "⑥", "⑦", "⑧", "⑨", "⑩",
      "⑪", "⑫", "⑬", "⑭", "⑮",
      "⑯", "⑰", "⑱", "⑲", "⑳"
    ];

    const number = tagIndex >= 0
      ? (circledNumbers[tagIndex] || (tagIndex + 1) + ".")
      : "";

    const el = document.createElement("div");
    el.className = "tagTitle";
    el.textContent = number + " " + (t.label || "");

    pushSign(el, pos, "text", 0, open, tagId);
  }
}

// 位置を指定した案内画像と、タグの見方を説明する案内板
function setupSigns(sdk, period) {
  clearSigns();
  signSdk = sdk;

  // 既存のconfig.jsに設定された案内画像はそのまま表示する
  const list = (SIGNS[buildingId] && SIGNS[buildingId][period.id]) || [];

  list.forEach((sg, i) => {
    let pos = null;

    if (sg.tag) {
      const t = (period.tags || []).find((x) => x.label === sg.tag);

      if (!t) {
        console.warn("案内パネル: タグ「" + sg.tag + "」が見つかりません");
        return;
      }

      pos = {
        x: t.x,
        y: t.y + (typeof sg.offsetY === "number" ? sg.offsetY : 0.8),
        z: t.z
      };

    } else if (["x", "y", "z"].every((k) => typeof sg[k] === "number")) {
      pos = { x: sg.x, y: sg.y, z: sg.z };

    } else {
      console.warn("案内パネル " + (i + 1) + "番目: tag か x,y,z のどちらかを書いてください");
      return;
    }

    if (!sg.image) {
      console.warn("案内パネル " + (i + 1) + "番目: image がありません");
      return;
    }

    pushSign(makeImageSign(sg.image), pos, "image", sg.width || 200, null);
  });

  // 最初の通常視点を取得して、案内板の位置を決める
  let guideAdded = false;

  sdk.Camera.pose.subscribe((pose) => {
    signPose = pose;

    // ドールハウス・間取り図では案内板の位置を決めない
    const isInsideView = !/dollhouse|floorplan/i.test(String(pose.mode));

    if (!guideAdded && isInsideView && pose.position && pose.rotation) {
      const yaw = pose.rotation.x * Math.PI / 180;
      const pitch = pose.rotation.y * Math.PI / 180;

      // カメラが向いている方向を計算
      const forward = {
        x: Math.sin(yaw) * Math.cos(pitch),
        y: Math.sin(pitch),
        z: -Math.cos(yaw) * Math.cos(pitch)
      };

      // カメラの約3m前方に案内板を設置
      const distance = 3.0;

            const guidePosition = {
  x: pose.position.x + forward.x * distance,
  y: pose.position.y + forward.y * distance + 0.8,
  z: pose.position.z + forward.z * distance
};

      const guideBoard = makeGuideBoard();

      pushSign(
        guideBoard,
        guidePosition,
        "image",
        320,
        null
      );

      guideAdded = true;

      console.log("タグ説明用の案内板を設置しました:", guidePosition);
    }

    updateSigns();
  });
}

// ============================================================
//  編集モード（?edit=1）：座標とSweep IDを画面に表示
// ============================================================
let editFrozen = false;
let lastPosText = "";
let lastSweepId = "";

function setupEditMode(sdk, iframe) {
  if (!EDIT_MODE) return;
  $("editInfo").style.display = "block";
  editFrozen = false;

  // マウスがモデルの外（このパネル上）に出たら値を固定する
  iframe.addEventListener("mouseenter", () => { editFrozen = false; });
  iframe.addEventListener("mouseleave", () => { editFrozen = true; });

  sdk.Pointer.intersection.subscribe((d) => {
    if (editFrozen || !d || !d.position) return;
    const f = (n) => Math.round(n * 10000) / 10000;
    lastPosText = "x: " + f(d.position.x) + ", y: " + f(d.position.y) + ", z: " + f(d.position.z) + ",";
    $("editPos").textContent = "座標: " + lastPosText;
  });

  sdk.Sweep.current.subscribe((s) => {
    if (s && s.sid) {
      lastSweepId = s.sid;
      $("editSweep").textContent = "Sweep ID: " + lastSweepId;
    }
  });
}

function copyText(text) {
  if (text && navigator.clipboard) navigator.clipboard.writeText(text);
}
$("copyPos").addEventListener("click", () => copyText(lastPosText));
$("copySweep").addEventListener("click", () => copyText(lastSweepId));

// ============================================================
//  時期の切り替え
// ============================================================
function resetUiForPeriod(period) {
  stopQuizTimer();
  $("quiz").style.display = "none";
  $("resultScreen").style.display = "none";
  closeTagPanel(false);
  clearSigns();

  questions = period.quiz || [];
  currentQuestion = 0;
  correctCount = 0;
  answerResults = [];
  detailedAnswers = [];

  // 内容がないメニューは隠す
  $("testButton").style.display = questions.length ? "block" : "none";

  lastPosText = "";
  lastSweepId = "";
  $("editPos").textContent = "座標: （モデル上にマウスを置く）";
  $("editSweep").textContent = "Sweep ID: -";

  document.querySelectorAll("#periodList button").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === period.id);
  });
}

async function switchPeriod(periodId) {
  const period = building.periods.find((p) => p.id === periodId);
  if (!period) return;

  const token = ++loadToken;

  // 切り替え前に、途中のメインクイズの回答を送る
  sendMainResults();

  currentPeriod = period;
  resetUiForPeriod(period);
  showOverlay((period.name || period.id) + " を読み込み中…", false);

  try {
    // iframe を作り直して、新しいモデルに接続する
    const old = $("showcase-iframe");
    const fresh = document.createElement("iframe");
    fresh.id = "showcase-iframe";
    fresh.allow = "fullscreen; xr-spatial-tracking";
    fresh.src = period.modelUrl;
    old.replaceWith(fresh);
    mpSdk = null;

    const sdk = await connect(fresh);
    if (token !== loadToken) return;      // その間に別の時期が選ばれた
    mpSdk = sdk;
    window.mpSdk = sdk;                    // コンソールでの確認用

    setupEditMode(sdk, fresh);
    setupSigns(sdk, period);
    const failed = await setupTags(sdk, period, token);
    if (token !== loadToken) return;

    if (failed.length) {
      showOverlay("追加できなかったタグ: " + failed.join("、") + "（詳細はコンソール）", true);
    } else {
      hideOverlay();
    }
  } catch (e) {
    console.error("モデルの読み込みエラー:", e);
    if (token === loadToken) {
      showOverlay("モデルを読み込めませんでした。config.js の modelUrl を確認してください。", true);
    }
  }
}

function buildPeriodList() {
  const list = $("periodList");
  list.innerHTML = "";
  building.periods.forEach((p) => {
    const b = document.createElement("button");
    b.textContent = p.name || p.id;
    b.dataset.id = p.id;
    b.addEventListener("click", () => {
      // メニューを閉じる
      list.classList.remove("open");
      $("quizMenu").classList.remove("open");
      if (currentPeriod && currentPeriod.id === p.id) return;
      switchPeriod(p.id);
    });
    list.appendChild(b);
  });
}

// 「階層の切り替え」を押すと、第1期・第2期…の一覧を開閉する
$("periodMenuButton").addEventListener("click", () => {
  $("periodList").classList.toggle("open");
});

// ============================================================
//  起動
// ============================================================
function init() {
  if (!building) {
    $("studentGateError").textContent =
      "建物ID「" + buildingId + "」が config.js にありません。使える建物: " +
      Object.keys(BUILDINGS).join("、") + (configNotice ? "\n" + configNotice : "");
    $("startMatterport").disabled = true;
    return;
  }

  document.title = building.name;
  $("buildingTitle").textContent = building.name;

  const warnings = validateBuilding(building);
  if (configNotice) warnings.unshift(configNotice);
  warnings.forEach((w) => {
    const li = document.createElement("li");
    li.textContent = w;
    $("configWarnings").appendChild(li);
    console.warn("設定の注意:", w);
  });

  $("studentGateForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const studentName = $("studentName").value.trim();
    const studentId = $("studentId").value.trim();
    if (!studentName || !studentId) {
      $("studentGateError").textContent = "氏名と学籍番号を入力してください。";
      return;
    }
    studentInfo = { studentName, studentId };
    $("studentGate").style.display = "none";

    buildPeriodList();
    const wanted = params.get("period");
    const first = building.periods.find((p) => p.id === wanted) || building.periods[0];
    switchPeriod(first.id);
  });
}

init();