/* =========================================================================
   Guess the Cricketer — game logic
   Vanilla ES2018. No network. WebView / WhatsApp-browser safe.
   Persistence: localStorage only (namespaced wg:guess-the-cricketer:*).
   V2: memo calls for KV/server streak sync + friend leaderboards — local-only here.
   ========================================================================= */
(function () {
  "use strict";

  var SLUG = "guess-the-cricketer";
  var NS = "wg:" + SLUG + ":";
  var MAX_GUESSES = 8;
  var ATTRS = ["name", "country", "role", "bat", "bowl", "debut", "ipl", "num"];
  // Board columns (name is the guessed identity, shown implicitly). We show 7 feedback columns.
  var COLS = ["country", "role", "bat", "bowl", "debut", "ipl", "num"];
  var COL_LABELS = {
    country: "Country", role: "Role", bat: "Bat", bowl: "Bowl",
    debut: "Debut", ipl: "IPL", num: "No."
  };
  var NUMERIC = { debut: true, num: true };

  var ALL = (window.CRICKETERS || []).slice();

  /* ---------- region + role + bowling adjacency for "close" feedback ---------- */
  var REGION = {
    "India": "subcontinent", "Pakistan": "subcontinent", "Sri Lanka": "subcontinent",
    "Bangladesh": "subcontinent", "Afghanistan": "subcontinent",
    "Australia": "oceania", "New Zealand": "oceania",
    "South Africa": "africa", "Zimbabwe": "africa",
    "West Indies": "caribbean", "USA": "americas",
    "England": "europe", "Ireland": "europe", "Netherlands": "europe"
  };
  function bowlFamily(b) {
    if (!b || b === "—") return "none";
    if (/offbreak|legbreak|orthodox|wrist-spin/.test(b)) return "spin";
    return "pace";
  }
  // roles that are "related" -> yellow when not exact
  function rolesClose(a, b) {
    if (a === b) return false;
    var all = "Allrounder";
    if (a === all || b === all) return true;             // allrounder ~ anything specialist
    if ((a === "Keeper" && b === "Batter") || (a === "Batter" && b === "Keeper")) return true;
    return false;
  }

  /* ---------- deterministic daily selection ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // seeded Fisher-Yates permutation of indices 0..n-1
  function seededPerm(n, seed) {
    var arr = [], i;
    for (i = 0; i < n; i++) arr.push(i);
    var rnd = mulberry32(seed);
    for (i = n - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  // IST "today" -> {ymd:"YYYY-MM-DD", dayNumber:int}
  // Date.now() is UTC epoch ms; shift +5:30 then read UTC getters => IST wall clock.
  function istInfo() {
    var ist = new Date(Date.now() + 5.5 * 3600000);
    var y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
    var ymd = y + "-" + pad2(m + 1) + "-" + pad2(d);
    var epoch = Date.UTC(2025, 0, 1);      // puzzle #1 = 1 Jan 2025 IST
    var dayUTC = Date.UTC(y, m, d);
    var dayNumber = Math.floor((dayUTC - epoch) / 86400000) + 1;
    return { ymd: ymd, dayNumber: dayNumber };
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  /* ---------- pools per mode ---------- */
  function poolFor(mode) {
    if (mode === "ipl") return ALL.filter(function (p) { return p.ipl && p.ipl !== "—"; });
    return ALL.slice(); // legend = full cross-era list
  }
  // Answers only come from players with a recorded shirt number, so the number
  // column always gives real feedback. The full pool stays guessable.
  function answerPoolFor(mode) {
    return poolFor(mode).filter(function (p) { return p.num != null; });
  }
  // A stable per-mode salt so IPL and Legend get independent daily answers.
  var SALT = { ipl: 19008, legend: 45777 };

  function answerFor(mode, dayNumber) {
    var pool = answerPoolFor(mode);
    var perm = seededPerm(pool.length, SALT[mode] || 1);
    var idx = ((dayNumber - 1) % pool.length + pool.length) % pool.length;
    return pool[perm[idx]];
  }

  /* ---------- storage ---------- */
  function lget(k, dflt) {
    try { var v = localStorage.getItem(NS + k); return v == null ? dflt : JSON.parse(v); }
    catch (e) { return dflt; }
  }
  function lset(k, v) {
    try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {}
  }

  function defaultStats() {
    return { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: [0,0,0,0,0,0,0,0], lastWinDay: null };
  }

  /* ---------- feedback computation ---------- */
  function evalGuess(guess, answer) {
    // returns per-COL: {state:'exact'|'close'|'wrong', val, arrow:'up'|'down'|null}
    var out = {};
    COLS.forEach(function (c) {
      var g = guess[c], a = answer[c];
      var res = { val: displayVal(c, g), arrow: null, state: "wrong" };
      if (NUMERIC[c]) {
        var gn = numOf(g), an = numOf(a);
        if (gn == null || an == null) {
          // Comparison impossible (no recorded number on one side): neutral tile,
          // no arrow, never implies right/wrong — but ALWAYS show the guess's own
          // value (res.val already holds it); a "?" here reads as missing data.
          res.state = "unknown";
          res.arrow = null;
        } else if (gn === an) {
          res.state = "exact";
        } else {
          var diff = Math.abs(gn - an);
          res.state = diff <= 3 ? "close" : "wrong";
          res.arrow = gn < an ? "up" : "down"; // answer is higher -> guess should go up
        }
      } else if (c === "country") {
        if (g === a) res.state = "exact";
        else if (REGION[g] && REGION[g] === REGION[a]) res.state = "close";
      } else if (c === "role") {
        if (g === a) res.state = "exact";
        else if (rolesClose(g, a)) res.state = "close";
      } else if (c === "bowl") {
        if (g === a) res.state = "exact";
        else if (g !== "—" && a !== "—" && bowlFamily(g) === bowlFamily(a)) res.state = "close";
      } else { // bat, ipl
        if (g === a) res.state = "exact";
      }
      out[c] = res;
    });
    return out;
  }
  function numOf(v) { return (v == null) ? null : (typeof v === "number" ? v : parseInt(v, 10)); }
  function displayVal(c, v) {
    if (v == null) return "—";
    return String(v);
  }

  /* ================= DOM refs ================= */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var board = $("#board"), input = $("#guessInput"), goBtn = $("#goBtn"),
      ac = $("#autocomplete"), statusEl = $("#status"), resultEl = $("#result"),
      yBody = $("#yBody"), yMeta = $("#yMeta"), puzzleNoEl = $("#puzzleNo"),
      modeSeg = $("#modeSeg"), unlimitedBtn = $("#unlimitedBtn"),
      statPlayed = $("#statPlayed"), statWin = $("#statWin"),
      statStreak = $("#statStreak"), statMax = $("#statMax"),
      fx = $("#fx");

  /* ================= game state ================= */
  var G = null; // current game object

  function newGame(opts) {
    var mode = opts.mode, unlimited = !!opts.unlimited;
    var info = istInfo();
    var dayNumber, answer, puzzleLabel;

    if (unlimited) {
      var pool = answerPoolFor(mode);
      answer = pool[Math.floor(Math.random() * pool.length)];
      dayNumber = null;
      puzzleLabel = "∞ Unlimited";
    } else {
      dayNumber = info.dayNumber;
      answer = answerFor(mode, dayNumber);
      puzzleLabel = "#" + dayNumber;
    }

    G = {
      mode: mode, unlimited: unlimited, dayNumber: dayNumber, ymd: info.ymd,
      answer: answer, guesses: [], results: [], over: false, won: false
    };

    // restore saved daily progress (only for the deterministic daily puzzle)
    if (!unlimited) {
      var saved = lget("progress:" + mode, null);
      if (saved && saved.day === dayNumber && saved.answer === answer.name) {
        G.guesses = saved.guesses || [];
        G.over = !!saved.over; G.won = !!saved.won;
        G.guesses.forEach(function (name) {
          var gp = byName(name);
          if (gp) G.results.push(evalGuess(gp, answer));
        });
      }
    }

    renderAll(puzzleLabel);
  }

  function byName(name) {
    for (var i = 0; i < ALL.length; i++) if (ALL[i].name === name) return ALL[i];
    return null;
  }

  /* ================= rendering ================= */
  function renderAll(puzzleLabel) {
    puzzleNoEl.textContent = puzzleLabel;
    document.body.classList.toggle("is-unlimited", !!G.unlimited);
    renderBoard();
    renderStats();
    renderYesterday();
    if (G.over) showResult(false);
    else hideResult();
    updateStatus();
    input.disabled = G.over; goBtn.disabled = G.over || !input.value.trim();
  }

  function renderBoard() {
    board.innerHTML = "";
    var i;
    for (i = 0; i < MAX_GUESSES; i++) {
      var row = document.createElement("div");
      row.className = "row";
      var res = G.results[i];
      if (!res) {
        row.className += " empty";
        // placeholder tiles
        COLS.forEach(function () {
          var t = document.createElement("div");
          t.className = "tile";
          var v = document.createElement("div"); v.className = "t-val";
          t.appendChild(v); row.appendChild(t);
        });
      } else {
        buildFilledRow(row, res, i, false);
      }
      board.appendChild(row);
    }
  }

  function buildFilledRow(row, res, rowIndex, animate) {
    COLS.forEach(function (c, ci) {
      var cell = res[c];
      var t = document.createElement("div");
      t.className = "tile " + cell.state + (NUMERIC[c] ? " num" : "");
      var v = document.createElement("div"); v.className = "t-val";
      v.textContent = cell.val;
      t.appendChild(v);
      if (cell.arrow) {
        var ar = document.createElement("div"); ar.className = "t-arrow";
        ar.textContent = cell.arrow === "up" ? "▲" : "▼";
        t.appendChild(ar);
      }
      if (animate) {
        t.style.animationDelay = (ci * 0.09) + "s";
        t.classList.add("reveal");
      }
      row.appendChild(t);
    });
  }

  function renderStats() {
    var s = getStats();
    statPlayed.textContent = s.played;
    statWin.textContent = s.played ? Math.round((s.wins / s.played) * 100) + "%" : "0%";
    statStreak.textContent = s.streak;
    statMax.textContent = s.maxStreak;
  }

  function renderYesterday() {
    var yInfo = istInfo();
    var yDay = yInfo.dayNumber - 1;
    if (yDay < 1) { yBody.textContent = "No previous puzzle yet — you're on day one."; yMeta.textContent = ""; return; }
    var ans = answerFor(G.mode, yDay);
    yBody.innerHTML = "Answer #" + yDay + " was <b>" + esc(ans.name) + "</b>.";
    yMeta.textContent = ans.country + " · " + ans.role + " · debut " + ans.debut +
      (ans.ipl !== "—" ? " · " + ans.ipl : "");
  }

  function updateStatus() {
    if (G.over) { statusEl.innerHTML = ""; return; }
    var left = MAX_GUESSES - G.guesses.length;
    statusEl.innerHTML = "<b>" + left + "</b> guess" + (left === 1 ? "" : "es") + " left · " +
      (G.mode === "ipl" ? "IPL Mode" : "Legend Mode");
  }

  /* ================= guessing ================= */
  function submitGuess(name) {
    if (G.over) return;
    var gp = byName(name);
    if (!gp) { rejectInput("Pick a name from the list"); return; }
    if (G.guesses.indexOf(name) !== -1) { rejectInput("Already guessed"); return; }

    var res = evalGuess(gp, G.answer);
    G.guesses.push(name);
    G.results.push(res);

    // render this row with animation
    var rowIndex = G.guesses.length - 1;
    var row = board.children[rowIndex];
    row.className = "row";
    row.innerHTML = "";
    buildFilledRow(row, res, rowIndex, true);

    var win = (name === G.answer.name);
    var lose = !win && G.guesses.length >= MAX_GUESSES;

    sfxTiles(res);
    if (navigator.vibrate) navigator.vibrate(win ? [30, 40, 60] : 18);

    input.value = ""; closeAc(); goBtn.disabled = true;

    if (win || lose) {
      G.over = true; G.won = win;
      persistProgress();
      recordResult(win, G.guesses.length);
      // reveal card after flip animation completes
      setTimeout(function () {
        showResult(true);
        renderStats();
        if (win) { celebrate(); sfxWin(); }
        else { sfxLose(); }
        if (navigator.vibrate) navigator.vibrate(win ? [40, 60, 40, 60, 120] : [120, 60, 120]);
      }, 620);
    } else {
      persistProgress();
      updateStatus();
    }
  }

  function rejectInput(msg) {
    input.classList.add("shake");
    setTimeout(function () { input.classList.remove("shake"); }, 420);
    toast(msg);
    if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
  }

  function persistProgress() {
    if (G.unlimited) return;
    lset("progress:" + G.mode, {
      day: G.dayNumber, answer: G.answer.name,
      guesses: G.guesses, over: G.over, won: G.won
    });
  }

  /* ================= stats / streak ================= */
  function getStats() {
    var s = lget("stats:" + G.mode, null);
    if (!s) { s = defaultStats(); }
    return s;
  }
  function recordResult(win, tries) {
    if (G.unlimited) return; // unlimited never touches streak/stats
    var s = getStats();
    // guard: only record once per day per mode
    var doneKey = "done:" + G.mode;
    var done = lget(doneKey, null);
    if (done === G.dayNumber) { return; }
    lset(doneKey, G.dayNumber);

    s.played += 1;
    if (win) {
      s.wins += 1;
      s.dist[tries - 1] = (s.dist[tries - 1] || 0) + 1;
      // streak continues only if the previous win was exactly yesterday's puzzle
      s.streak = (s.lastWinDay === G.dayNumber - 1) ? s.streak + 1 : 1;
      s.lastWinDay = G.dayNumber;
      if (s.streak > s.maxStreak) s.maxStreak = s.streak;
    } else {
      s.streak = 0;
    }
    lset("stats:" + G.mode, s);
    // archive
    var arch = lget("archive", {});
    arch[G.mode + ":" + G.dayNumber] = { won: win, tries: win ? tries : null, answer: G.answer.name };
    lset("archive", arch);
  }

  /* ================= result card ================= */
  function showResult(fresh) {
    var a = G.answer;
    var won = G.won;
    var tries = G.guesses.length;
    resultEl.innerHTML = "";

    var verdict = document.createElement("p");
    verdict.className = "verdict " + (won ? "win" : "lose");
    verdict.textContent = won
      ? "Caught! Solved in " + tries + "/" + MAX_GUESSES
      : "Bowled. Better luck tomorrow";
    resultEl.appendChild(verdict);

    var card = document.createElement("div");
    card.className = "pcard" + (won ? "" : " lose");
    card.innerHTML =
      '<div class="pcard-top">' +
        '<div class="pcard-num">' + (a.num != null ? a.num : "—") + '</div>' +
        '<p class="pcard-role">' + esc(a.role) + '</p>' +
        '<h3 class="pcard-name">' + esc(a.name) + '</h3>' +
        '<p class="pcard-country">' + esc(a.country) + '</p>' +
      '</div>' +
      '<dl class="pcard-grid">' +
        cell("Batting", a.bat + "-hand") +
        cell("Bowling", a.bowl) +
        cell("Debut", String(a.debut)) +
        cell("IPL Team", a.ipl === "—" ? "Never played IPL" : a.ipl) +
      '</dl>';
    resultEl.appendChild(card);

    // actions
    var actions = document.createElement("div");
    actions.className = "result-actions";
    var shareBtn = document.createElement("button");
    shareBtn.className = "pill-btn share-btn";
    shareBtn.textContent = "Share result";
    shareBtn.addEventListener("click", doShare);
    var copyBtn = document.createElement("button");
    copyBtn.className = "pill-btn";
    copyBtn.textContent = "Copy grid";
    copyBtn.addEventListener("click", function () { copyText(buildShareText()); toast("Copied to clipboard"); });
    actions.appendChild(shareBtn);
    actions.appendChild(copyBtn);
    if (G.unlimited) {
      var nextBtn = document.createElement("button");
      nextBtn.className = "pill-btn";
      nextBtn.textContent = "Next random ↻";
      nextBtn.addEventListener("click", function () { newGame({ mode: G.mode, unlimited: true }); });
      actions.appendChild(nextBtn);
    }
    resultEl.appendChild(actions);

    // emoji preview
    var pre = document.createElement("div");
    pre.className = "share-preview show";
    pre.textContent = buildEmojiGridOnly();
    resultEl.appendChild(pre);

    resultEl.classList.add("show");
    input.disabled = true;
    if (fresh) resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function hideResult() { resultEl.classList.remove("show"); resultEl.innerHTML = ""; }
  function cell(dt, dd) {
    return '<div class="pcard-cell"><dt>' + esc(dt) + '</dt><dd>' + esc(dd) + '</dd></div>';
  }

  /* ================= share ================= */
  function stateEmoji(st) {
    return st === "exact" ? "🟩" : st === "close" ? "🟨" : st === "unknown" ? "⬜" : "⬛";
  }
  function buildEmojiGridOnly() {
    var lines = [];
    G.results.forEach(function (res) {
      var line = COLS.map(function (c) { return stateEmoji(res[c].state); }).join("");
      lines.push(line);
    });
    return lines.join("\n");
  }
  function buildShareText() {
    var head = "Guess the Cricketer " + (G.unlimited ? "∞" : "#" + G.dayNumber) +
      "  " + (G.won ? (G.guesses.length + "/" + MAX_GUESSES) : "X/" + MAX_GUESSES) +
      "  " + (G.mode === "ipl" ? "🏏 IPL" : "🎓 Legend");
    var grid = buildEmojiGridOnly();
    var s = getStats();
    var streakLine = (!G.unlimited && s.streak > 1) ? ("🔥 " + s.streak + " day streak") : "";
    var url = shareUrl();
    return [head, "", grid, "", streakLine, url].filter(function (x) { return x !== ""; }).join("\n");
  }
  function shareUrl() {
    try {
      var u = location.origin + location.pathname;
      return u.indexOf("http") === 0 ? u : "";
    } catch (e) { return ""; }
  }
  function doShare() {
    var text = buildShareText();
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () {});
      return;
    }
    // wa.me fallback
    var wa = "https://wa.me/?text=" + encodeURIComponent(text);
    var win = window.open(wa, "_blank");
    if (!win) { copyText(text); toast("Copied — paste into WhatsApp"); }
    else { copyText(text); }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    } else { legacyCopy(text); }
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "absolute"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ================= autocomplete ================= */
  var acIndex = -1, acItems = [];
  function onInput() {
    var q = norm(input.value.trim());
    goBtn.disabled = G.over || !input.value.trim();
    if (!q) { closeAc(); return; }
    var pool = poolFor(G.mode);
    var scored = [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (G.guesses.indexOf(p.name) !== -1) continue;
      var nn = norm(p.name);
      var pos = nn.indexOf(q);
      if (pos === -1) {
        // token start match
        var tokens = nn.split(" ");
        var hit = false;
        for (var t = 0; t < tokens.length; t++) { if (tokens[t].indexOf(q) === 0) { hit = true; break; } }
        if (!hit) continue;
        pos = 5;
      }
      scored.push({ p: p, score: pos });
    }
    scored.sort(function (a, b) { return a.score - b.score || (a.p.name < b.p.name ? -1 : 1); });
    scored = scored.slice(0, 8);
    if (!scored.length) { closeAc(); return; }
    renderAc(scored.map(function (s) { return s.p; }), q);
  }
  function renderAc(list, q) {
    ac.innerHTML = "";
    acItems = list; acIndex = -1;
    list.forEach(function (p, i) {
      var el = document.createElement("div");
      el.className = "ac-item"; el.setAttribute("role", "option");
      el.innerHTML = '<span class="ac-name">' + highlight(p.name, q) + '</span>' +
        '<span class="ac-meta">' + p.country + " · " + shortRole(p.role) + '</span>';
      el.addEventListener("mousedown", function (e) { e.preventDefault(); choose(p.name); });
      ac.appendChild(el);
    });
    ac.classList.add("open");
  }
  function shortRole(r) { return r === "Allrounder" ? "AR" : r === "Keeper" ? "WK" : r === "Batter" ? "BAT" : "BWL"; }
  function highlight(name, q) {
    var nn = norm(name), pos = nn.indexOf(q);
    if (pos === -1) return esc(name);
    return esc(name.slice(0, pos)) + "<b>" + esc(name.slice(pos, pos + q.length)) + "</b>" + esc(name.slice(pos + q.length));
  }
  function choose(name) {
    input.value = name; closeAc(); submitGuess(name);
  }
  function closeAc() { ac.classList.remove("open"); ac.innerHTML = ""; acItems = []; acIndex = -1; }
  function moveAc(dir) {
    if (!acItems.length) return;
    acIndex = (acIndex + dir + acItems.length) % acItems.length;
    var kids = ac.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("active", i === acIndex);
    kids[acIndex].scrollIntoView({ block: "nearest" });
  }

  /* ================= audio (synth, gesture-gated) ================= */
  var actx = null;
  function ac_() {
    if (actx) return actx;
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
    return actx;
  }
  function beep(freq, dur, type, vol, when) {
    var c = ac_(); if (!c) return;
    if (c.state === "suspended") c.resume();
    var t0 = c.currentTime + (when || 0);
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine"; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.13, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function sfxTiles(res) {
    // ascending ticks per column, pitch by state
    COLS.forEach(function (c, i) {
      var st = res[c].state;
      var f = st === "exact" ? 620 : st === "close" ? 480 : 300;
      beep(f, 0.09, "triangle", 0.06, i * 0.09);
    });
  }
  function sfxWin() {
    var notes = [523, 659, 784, 1047];
    notes.forEach(function (n, i) { beep(n, 0.22, "triangle", 0.14, i * 0.1); });
    beep(1568, 0.3, "sine", 0.09, 0.45);
  }
  function sfxLose() {
    beep(300, 0.28, "sawtooth", 0.1, 0);
    beep(220, 0.4, "sawtooth", 0.1, 0.16);
  }

  /* ================= confetti (cricket ball + bail colours) ================= */
  var fxCtx = null, fxParts = [], fxRAF = null;
  function celebrate() {
    if (!fx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = fx.clientWidth * dpr; fx.height = fx.clientHeight * dpr;
    fxCtx = fx.getContext("2d");
    var colors = ["#a8322b", "#2f6b3d", "#c98a1c", "#f3ead2"];
    fxParts = [];
    var W = fx.width, H = fx.height;
    for (var i = 0; i < 90; i++) {
      fxParts.push({
        x: W / 2 + (Math.random() - 0.5) * W * 0.3,
        y: H * 0.32,
        vx: (Math.random() - 0.5) * 14 * dpr,
        vy: (Math.random() * -12 - 5) * dpr,
        g: 0.42 * dpr,
        s: (4 + Math.random() * 5) * dpr,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
        col: colors[(Math.random() * colors.length) | 0],
        life: 1
      });
    }
    if (fxRAF) cancelAnimationFrame(fxRAF);
    var start = performance.now();
    (function loop(now) {
      var dt = 1;
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      var alive = 0;
      for (var i = 0; i < fxParts.length; i++) {
        var p = fxParts[i];
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        p.vx *= 0.99;
        if (p.y < fx.height + 40) alive++;
        p.life = Math.max(0, 1 - (now - start) / 2600);
        fxCtx.save();
        fxCtx.globalAlpha = p.life;
        fxCtx.translate(p.x, p.y); fxCtx.rotate(p.rot);
        fxCtx.fillStyle = p.col;
        fxCtx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.6);
        fxCtx.restore();
      }
      if (alive > 0 && now - start < 2600) fxRAF = requestAnimationFrame(loop);
      else fxCtx.clearRect(0, 0, fx.width, fx.height);
    })(start);
  }

  /* ================= toast ================= */
  var toastEl = null, toastT = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div"); toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 1900);
  }

  /* ================= helpers ================= */
  function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim(); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]; }); }

  /* ================= mode + theme ================= */
  function currentMode() { return lget("mode", "ipl"); }
  function setMode(mode) {
    lset("mode", mode);
    var btns = modeSeg.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute("aria-pressed", btns[i].dataset.mode === mode ? "true" : "false");
    newGame({ mode: mode, unlimited: G ? G.unlimited : false });
  }

  function initTheme() {
    var saved = lget("theme", null);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    var btn = $("#themeBtn");
    updateThemeIcon();
    btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var next;
      if (!cur) {
        var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        next = prefersDark ? "light" : "dark";
      } else { next = cur === "dark" ? "light" : "dark"; }
      document.documentElement.setAttribute("data-theme", next);
      lset("theme", next); updateThemeIcon();
    });
    function updateThemeIcon() {
      var cur = document.documentElement.getAttribute("data-theme");
      var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var isDark = cur ? cur === "dark" : prefersDark;
      btn.textContent = isDark ? "☀" : "☾";
      btn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
    }
  }

  /* ================= wiring ================= */
  function init() {
    if (!ALL.length) { statusEl.textContent = "Data failed to load."; return; }
    initTheme();

    var mode = currentMode();
    // set mode buttons
    var btns = modeSeg.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.setAttribute("aria-pressed", b.dataset.mode === mode ? "true" : "false");
        b.addEventListener("click", function () { if (b.dataset.mode !== G.mode || G.unlimited) setMode(b.dataset.mode); });
      })(btns[i]);
    }

    unlimitedBtn.addEventListener("click", function () {
      var goUnlimited = !G.unlimited;
      unlimitedBtn.classList.toggle("on", goUnlimited);
      unlimitedBtn.setAttribute("aria-pressed", goUnlimited ? "true" : "false");
      unlimitedBtn.textContent = goUnlimited ? "Daily puzzle" : "Unlimited ∞";
      newGame({ mode: G.mode, unlimited: goUnlimited });
    });

    input.addEventListener("input", onInput);
    input.addEventListener("focus", function () { ac_(); onInput(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveAc(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveAc(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (acIndex >= 0 && acItems[acIndex]) choose(acItems[acIndex].name);
        else if (acItems.length === 1) choose(acItems[0].name);
        else if (input.value.trim()) {
          // try exact/normalized match
          var q = norm(input.value.trim());
          var match = null;
          for (var k = 0; k < ALL.length; k++) if (norm(ALL[k].name) === q) { match = ALL[k]; break; }
          if (match) choose(match.name); else rejectInput("Pick a name from the list");
        }
      } else if (e.key === "Escape") { closeAc(); }
    });
    goBtn.addEventListener("click", function () {
      if (acIndex >= 0 && acItems[acIndex]) choose(acItems[acIndex].name);
      else if (acItems.length >= 1) choose(acItems[0].name);
      else rejectInput("Pick a name from the list");
    });
    document.addEventListener("click", function (e) {
      if (!ac.contains(e.target) && e.target !== input) closeAc();
    });

    // hash routing: #/unlimited
    if (/unlimited/i.test(location.hash)) {
      newGame({ mode: mode, unlimited: true });
      unlimitedBtn.classList.add("on");
      unlimitedBtn.setAttribute("aria-pressed", "true");
      unlimitedBtn.textContent = "Daily puzzle";
    } else {
      newGame({ mode: mode, unlimited: false });
    }
  }

  function wireKeyHelp() {
    var btn = document.getElementById("keyHelp"), panel = document.getElementById("keyDetail");
    if (btn && panel) btn.addEventListener("click", function () { panel.hidden = !panel.hidden; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { init(); wireKeyHelp(); });
  else { init(); wireKeyHelp(); }
})();
