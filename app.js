// ============================================================
//  app.js ― プログラム本体（教員は触らなくてOK）
//  内容はすべて config.js から読み込みます
// ============================================================
import { connect } from 'MP_SDK';
import { SETTINGS, BUILDINGS as LOCAL_BUILDINGS } from './config.js';

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
}

function answer(selected) {
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
});

$("endTestButton").addEventListener("click", () => {
  $("quiz").style.display = "none";

  const total = answerResults.length;
  const accuracy = total > 0 ? (correctCount / total) * 100 : 0;

  $("score").textContent = "正解数　" + correctCount + " / " + total + "問";
  $("accuracy").textContent = "正答率　" + accuracy.toFixed(1) + "%";

  const area = $("answerResults");
  area.innerHTML = "";
  answerResults.forEach((r, i) => {
    const p = document.createElement("p");
    p.textContent = "第" + (i + 1) + "問　" + r;
    area.appendChild(p);
  });

  sendMainResults();
  $("resultScreen").style.display = "block";
});

$("closeResultButton").addEventListener("click", () => {
  $("resultScreen").style.display = "none";
});

// ============================================================
//  ◇メニュー・動画パネル
// ============================================================
$("menuButton").addEventListener("click", () => {
  $("quizMenu").classList.toggle("open");
});

function closeVideo() {
  $("mainVideoFrame").src = "";
  $("videoPanel").style.display = "none";
}

$("videoButton").addEventListener("click", () => {
  const id = currentPeriod && (currentPeriod.videoId || building.videoId);
  if (!id) return;
  $("mainVideoFrame").src = "https://www.youtube.com/embed/" + encodeURIComponent(id);
  $("videoFallbackLink").href = "https://www.youtube.com/watch?v=" + encodeURIComponent(id);
  $("videoPanel").style.display = "block";
});

$("closeVideoButton").addEventListener("click", closeVideo);

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

// 「‹ 1 of 6 ›」：前後のタグへ移動してパネルを切り替える（最後の次は最初に戻る）
function gotoTag(delta) {
  const n = panelTagList.length;
  if (n < 2 || panelTagId === null) return;
  const i = panelTagList.indexOf(panelTagId);
  const id = panelTagList[(i + delta + n) % n];
  try {
    const p = panelSdk.Mattertag.navigateToTag(id, panelSdk.Mattertag.Transition.FLY, true);
    if (p && p.catch) p.catch((e) => console.error("タグへの移動エラー:", e));
  } catch (e) {
    console.error("タグへの移動エラー:", e);
  }
  openTagPanel(id, panelTagMap[id], panelPeriod);
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
  const qs = { cq: 0, score: 0, answered: false, picked: -1, finished: false, sent: false, detailed: [], note: "", scroll: 0 };
  function renderQuiz() {
    const wrap = mk("div", "tpQuiz");
    wrap.style.flex = "1";
    body.appendChild(wrap);
    // スクロール位置を覚えておく（「回答する」で描き直しても位置を戻すため）
    wrap.addEventListener("scroll", () => { qs.scroll = wrap.scrollTop; });
    wrap.appendChild(mk("h3", "", ""));

    if (qs.finished) {
      wrap.appendChild(mk("p", "q", "クイズ終了！"));
      wrap.appendChild(mk("div", "res", quiz.length + "問中 " + qs.score + " 問正解！"));
      return;
    }

    const q = quiz[qs.cq];
    wrap.appendChild(mk("p", "q", q.question));

    const corIdx = LETTERS.indexOf(q.answer);
    q.options.forEach((opt, i) => {
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
      if (qs.picked < 0) { res.textContent = "選択肢を選んでね！"; return; }
      qs.answered = true;
      const ok = qs.picked === corIdx;
      qs.detailed.push({
        questionText: q.question,
        selectedAnswer: q.options[qs.picked],
        correctAnswer: q.options[corIdx],
        isCorrect: ok
      });
      if (ok) qs.score++;
      qs.note = ok ? "正解！🎉" : "不正解！";
      showTab("quiz");
    });

    nextBtn.addEventListener("click", () => {
      if (qs.cq < quiz.length - 1) {
        qs.cq++; qs.answered = false; qs.picked = -1; qs.note = ""; qs.scroll = 0;   // 次の問題は一番上から
      } else {
        qs.finished = true;
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
  $("quiz").style.display = "none";
  $("resultScreen").style.display = "none";
  closeVideo();
  closeTagPanel(false);

  questions = period.quiz || [];
  currentQuestion = 0;
  correctCount = 0;
  answerResults = [];
  detailedAnswers = [];

  // 内容がないメニューは隠す
  $("testButton").style.display = questions.length ? "block" : "none";
  $("videoButton").style.display = (period.videoId || building.videoId) ? "block" : "none";

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