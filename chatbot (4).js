(function initRestaurantChatbot(){
  "use strict";

  const CONFIG = Object.freeze({
    endpointStream: "https://vyb9wqzt9b.execute-api.eu-central-1.amazonaws.com/prod/api/chat-stream",
    themeKey: "resto_chat_theme",
    historyKey: "resto_chat_history",
    categoryKey: "resto_chat_category",
    clientIdKey: "resto_chat_client_id",
    spamStateKey: "resto_chat_spam_state"
  });

  const CATEGORIES = Object.freeze([
    { key: "starters_soups", label: "🍽️ Előételek & Levesek", sub: "Meze, levesek, könnyű kezdés" },
    { key: "mains",          label: "🍖 Főételek (húsok, halak, saláták)", sub: "Húsok, halak, saláták, köretek" },
    { key: "desserts",       label: "🍰 Desszertek",           sub: "Édes levezetés, klasszikusok" },
    { key: "drinks",         label: "🍹 Italok",               sub: "Koktélok, borok, üdítők, kávé" },
    { key: "info",           label: "📍 Foglalás & Info",       sub: "Nyitvatartás, elérhetőség, tudnivalók" },
  ]);

  const TEXT = Object.freeze({
    title: "Luna",
    online: "Online",
    placeholderDisabled: "Írd be a kérdésed…",
    send: "Küldés",
    launcher: "AI",
    greet: "Szia! Miben segíthetek az étteremmel kapcsolatban?",
    askAfterPick: "Pontosan mivel kapcsolatban tudok segíteni?",
    offTopic: "Ezzel kapcsolatban itt nem tudok segíteni. Kérdezz bátran az éttermünkről!",
    networkError: "Hálózati hiba történt. Próbáld újra később.",
    empty: "Nem kaptam választ. Megpróbálod rövidebben?",
    mismatch: (suggestedLabel) =>
      `Úgy tűnik, ez inkább a(z) ${suggestedLabel} témához tartozik. Kérlek válts témát felül, és segítek.`,
    rateLimit: (sec) =>
      `Most túl gyorsan érkeznek a kérdések. Kérlek várj ${sec} mp-et, és próbáld újra.`,
    busy: "Már válaszolok egy kérdésre — kérlek várj egy pillanatot.",
    spamBlocked: (sec) =>
      `Túl sok kérdés érkezett rövid idő alatt. A chat ${sec} mp-re ideiglenesen le lett tiltva.`
  });

  const DEFAULT_CATEGORY = "auto";

  const timeFormatter = new Intl.DateTimeFormat("hu-HU", { hour: "2-digit", minute: "2-digit" });

  // client-side spam: 5 perc / 30+ → 3 perc tiltás
  const SPAM = Object.freeze({
    windowMs: 5 * 60 * 1000,
    maxInWindow: 30,
    blockMs: 3 * 60 * 1000
  });

  function nowMs(){ return Date.now(); }

  function safeRead(key){
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeWrite(key,val){
    try { localStorage.setItem(key,val); } catch {}
  }
  function safeRemove(key){
    try { localStorage.removeItem(key); } catch {}
  }
  function msToSecCeil(ms){
    return Math.max(1, Math.ceil(ms / 1000));
  }

  function getOrCreateClientId(){
    const existing = safeRead(CONFIG.clientIdKey);
    if (existing && existing.length >= 8) return existing;

    const id = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : ("cid_" + Math.random().toString(16).slice(2) + "_" + nowMs().toString(16));

    safeWrite(CONFIG.clientIdKey, id);
    return id;
  }

  function readSpamState(){
    try {
      const raw = safeRead(CONFIG.spamStateKey);
      if (!raw) return { blockedUntil: 0, sent: [] };
      const obj = JSON.parse(raw);
      return {
        blockedUntil: Number(obj.blockedUntil || 0),
        sent: Array.isArray(obj.sent) ? obj.sent.map(Number).filter(Number.isFinite) : []
      };
    } catch {
      return { blockedUntil: 0, sent: [] };
    }
  }
  function writeSpamState(st){
    safeWrite(CONFIG.spamStateKey, JSON.stringify(st));
  }

  function isOffTopic(){
    return false;
  }

  class RestaurantChatbot {
    constructor(){
      this.host = createHost();
      this.shadow = this.createShadowRoot(this.host);
      this.shadow.innerHTML = this.template();
      this.nodes = this.cacheNodes();

      this.history = [];
      this.isSending = false;
      this.abortController = null;

      this.selectedCategory = DEFAULT_CATEGORY;
      this.categoryRowEl = null;

      this.topicMenuOpen = false;
      this.blockTimer = null;

      this.initTheme();
      this.restoreHistory();
      this.renderHistory();
      this.bindEvents();

      this.setInputEnabled(true);

      if(!this.history.length){
        this.addBot(TEXT.greet, {persist:false});
      }

      this.renderTopicMenu(); // dropdown menü feltöltése

      // ha korábbról tiltva van
      this.applySpamBlockIfNeeded(true);

      this.updateTopicUi();
      this.scrollToEnd();
      this.setPanelVisible(true);
    }

    template(){
      return `
        <style>
          *,*::before,*::after{box-sizing:border-box}
          :host{all:initial}

          .palette{
            --bg: rgba(6, 8, 16, .70);
            --panel: rgba(12, 16, 26, .72);
            --layer: rgba(5, 8, 18, .55);
            --input: rgba(18, 23, 36, .75);
            --fg:#e9eefc;
            --muted:#9fb2ca;
            --border: rgba(255,255,255,.10);
            --border2: rgba(255,255,255,.14);
            --assist: rgba(16, 22, 35, .76);
            --userGrad: linear-gradient(135deg,#2eb5ff,#8e6bff);
            --accentGrad: linear-gradient(135deg,#2eb5ff,#8e6bff);
            --accentSoft: rgba(46,181,255,.18);
            --shadow: 0 30px 80px rgba(0,0,0,.55);
            --shadowSoft: 0 16px 40px rgba(0,0,0,.30);
            --scrollTrack: rgba(255,255,255,.06);
            --scrollThumb: rgba(255,255,255,.20);
            --chip-bg: rgba(255,255,255,.06);
            --chip-bg2: rgba(255,255,255,.10);
            --chip-fg: #e9eefc;
            --radius: 22px;
            --font: 12.6px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial;
          }

          .palette[data-theme="light"]{
            --bg: rgba(248,250,252,.82);
            --panel: rgba(255,255,255,.88);
            --layer: rgba(245,247,252,.75);
            --input: rgba(237,241,252,.92);
            --fg:#10162a;
            --muted:#5c667d;
            --border: rgba(16,22,42,.10);
            --border2: rgba(16,22,42,.14);
            --assist: rgba(255,255,255,.92);
            --shadow: 0 30px 80px rgba(16,22,42,.22);
            --shadowSoft: 0 16px 40px rgba(16,22,42,.14);
            --scrollTrack: rgba(16,22,42,.06);
            --scrollThumb: rgba(16,22,42,.22);
            --chip-bg: rgba(16,22,42,.04);
            --chip-bg2: rgba(16,22,42,.08);
            --chip-fg: #10162a;
            --accentSoft: rgba(88,164,255,.18);
          }

          .wrap{
            position:fixed;
            right:22px;
            bottom:90px;
            width: 480px;
            max-width: calc(100vw - 28px);
            height: clamp(520px, 74vh, 760px);
            display:flex;
            flex-direction:column;
            border-radius: var(--radius);
            background: var(--bg);
            color: var(--fg);
            box-shadow: var(--shadow);
            font: var(--font);
            overflow:hidden;
            backdrop-filter: blur(22px) saturate(1.2);
            -webkit-backdrop-filter: blur(22px) saturate(1.2);

            opacity: 1;
            transform: translateY(0) scale(1);
            transition: transform .18s ease, opacity .18s ease;
            will-change: transform, opacity;
          }

          .wrap.isHidden{
            opacity: 0;
            transform: none;
            pointer-events:none;
          }

          .wrap::before{
            content:"";
            position:absolute;
            inset:0;
            padding:1px;
            border-radius: var(--radius);
            background: linear-gradient(135deg, rgba(46,181,255,.55), rgba(142,107,255,.50), rgba(255,255,255,.14));
            -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
            -webkit-mask-composite: xor;
            mask-composite: exclude;
            pointer-events:none;
            opacity:.85;
          }

          .header{
            position:relative;
            display:flex;
            align-items:center;
            gap:12px;
            padding: 14px 16px 12px;
            background: linear-gradient(135deg, rgba(46,181,255,.96), rgba(142,107,255,.92));
            color:#fff;
            box-shadow: 0 16px 40px rgba(0,0,0,.28);
          }

          .header::after{
            content:"";
            position:absolute;
            inset:-40px -80px auto -80px;
            height:120px;
            background: radial-gradient(circle at 30% 20%, rgba(255,255,255,.35), transparent 60%);
            opacity:.65;
            pointer-events:none;
          }

          .brand{
            width:38px;height:38px;border-radius: 14px;
            background: rgba(255,255,255,.16);
            display:flex;align-items:center;justify-content:center;
            box-shadow: 0 14px 30px rgba(0,0,0,.22);
            border:1px solid rgba(255,255,255,.20);
            flex:0 0 auto;
          }
          .brand svg{width:20px;height:20px;opacity:.95}

          .title-row{display:flex;flex-direction:column;gap:2px;min-width:0}
          .title{font-size:15.2px;font-weight:800;letter-spacing:.02em;line-height:1.15}
          .subtitle{display:flex;align-items:center;gap:8px;font-size:11.5px;opacity:.95;flex-wrap:wrap}
          .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 12px rgba(34,197,94,.9)}
          .badge{
            padding: 2px 8px;border-radius: 999px;
            border:1px solid rgba(255,255,255,.24);
            background: rgba(0,0,0,.14);
            font-size: 11px;
            white-space:nowrap;
          }

          .actions{margin-left:auto;display:flex;gap:8px;z-index:2}
          .iconBtn{
            width:34px;height:34px;border-radius: 14px;
            border:1px solid rgba(255,255,255,.22);
            background: rgba(0,0,0,.14);
            color:#fff;cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            transition: transform .12s ease, background .12s ease, opacity .12s ease;
          }
          .iconBtn:hover{transform: translateY(-1px); background: rgba(0,0,0,.20)}
          .iconBtn:active{transform: translateY(0); opacity:.92}
          .closeBtn{font-size:20px;line-height:1}

          .msgs{
            flex:1;
            padding: 14px;
            background: var(--layer);
            overflow:auto;
            scrollbar-width:thin;
            scrollbar-color: var(--scrollThumb) var(--scrollTrack);
          }
          .msgs::-webkit-scrollbar{width:8px}
          .msgs::-webkit-scrollbar-track{background:var(--scrollTrack);border-radius:999px}
          .msgs::-webkit-scrollbar-thumb{background:var(--scrollThumb);border-radius:999px}

          .row{display:flex;gap:10px;align-items:flex-end;margin-bottom:10px;animation: msgIn .14s ease-out}
          .row.user{justify-content:flex-end}
          @keyframes msgIn{from{transform: translateY(6px); opacity:0}to{transform: translateY(0); opacity:1}}

          .avatar{
            width:28px;height:28px;border-radius: 12px;
            background: linear-gradient(135deg, rgba(46,181,255,.35), rgba(142,107,255,.28));
            border:1px solid var(--border2);
            box-shadow: var(--shadowSoft);
            display:flex;align-items:center;justify-content:center;
            flex:0 0 auto;
          }
          .avatar svg{width:16px;height:16px;opacity:.9}
          .row.user .avatar{display:none}

          .bubble{
            max-width: 78%;
            padding: 11px 13px;
            border-radius: 18px;
            white-space: pre-wrap;
            word-break: break-word;
            box-shadow: var(--shadowSoft);
            border:1px solid var(--border);
          }
          .bot .bubble{background: var(--assist);color: var(--fg);border-bottom-left-radius: 8px;}
          .user .bubble{background: var(--userGrad);color:#fff;border:none;border-bottom-right-radius: 8px;}

          .bubble.isTyping{
            display:flex;
            align-items:center;
            gap:8px;
            background: rgba(255,255,255,.06);
          }
          .typingDots{display:inline-flex;gap:6px;align-items:center;}
          .typingDots span{
            width:6px;height:6px;border-radius:50%;
            background: rgba(255,255,255,.55);
            opacity:.6;
            animation: bounce 1.1s infinite;
          }
          .palette[data-theme="light"] .typingDots span{background: rgba(16,22,42,.45)}
          .typingDots span:nth-child(2){animation-delay:.15s}
          .typingDots span:nth-child(3){animation-delay:.30s}
          @keyframes bounce{0%,80%,100%{transform: translateY(0);opacity:.5}40%{transform: translateY(-4px);opacity:1}}

          .meta{font-size:10px;color: var(--muted);margin-top: 4px;text-align:right;padding-right: 2px;}

          /* opciók kompakt + keskeny */
          .row.options{
            flex-direction:column;
            gap:8px;
            align-items:flex-start;
          }
          .catCard{
            width: clamp(220px, 55%, 320px);
            display:flex;align-items:center;justify-content:space-between;gap:10px;
            padding: 9px 10px;
            border-radius: 14px;
            border:1px solid var(--border);
            background: linear-gradient(180deg, var(--chip-bg), rgba(255,255,255,.02));
            color: var(--chip-fg);
            cursor:pointer;box-shadow: var(--shadowSoft);
            transition: transform .12s ease, border-color .12s ease, background .12s ease;
          }
          .catCard:hover{transform: translateY(-1px);border-color: rgba(46,181,255,.45);background: linear-gradient(180deg, var(--chip-bg2), rgba(255,255,255,.04));}
          .catLeft{display:flex;flex-direction:column;gap:1px;min-width:0}
          .catTitle{font-weight:800;font-size:12.2px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .catSub{font-size:10.4px;line-height:1.2;color: var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .arrow{width:24px;height:24px;border-radius:10px;border:1px solid var(--border2);background: rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
          .arrow svg{width:14px;height:14px;opacity:.9}

          /* ✅ ÚJ: dropdown témaváltó */
          .topicbar{
            position:relative;
            display:flex;
            align-items:center;
            gap:10px;
            padding:10px 12px;
            border-top:1px solid var(--border);
            background: rgba(10, 14, 24, .45);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
          }
          .palette[data-theme="light"] .topicbar{background: rgba(255,255,255,.75);}

          .topicSelect{
            width:100%;
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:10px;
            padding: 9px 12px;
            border-radius: 16px;
            border:1px solid var(--border2);
            background: rgba(255,255,255,.06);
            color: var(--fg);
            cursor:pointer;
            font-weight:900;
            box-shadow: var(--shadowSoft);
          }

          .topicSelect.isLocked{
            opacity: .55;
            pointer-events: none;
            cursor: not-allowed;
          }


          .topicLeft{
            display:flex;
            align-items:center;
            gap:10px;
            min-width:0;
          }
          .topicDot{
            width:8px;height:8px;border-radius:50%;
            background: rgba(46,181,255,.9);
            box-shadow: 0 0 14px rgba(46,181,255,.65);
            flex:0 0 auto;
          }
          .topicText{
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
            font-size: 12.2px;
          }
          .caret{opacity:.9}

          .topicMenu{
            position:absolute;
            left:12px;
            right:12px;
            bottom: calc(100% + 10px);
            border-radius: 18px;
            border:1px solid var(--border2);
            background: rgba(10, 14, 24, .92);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
            box-shadow: var(--shadow);
            overflow:hidden;
            transform-origin: bottom;
            animation: pop .12s ease-out;
            z-index: 10;
          }
          .palette[data-theme="light"] .topicMenu{
            background: rgba(255,255,255,.95);
          }
          @keyframes pop{
            from{transform: translateY(6px) scale(.98); opacity:0}
            to{transform: translateY(0) scale(1); opacity:1}
          }

          .menuHeader{
            padding: 10px 12px;
            font-weight: 900;
            font-size: 11.6px;
            color: var(--muted);
            border-bottom:1px solid var(--border);
          }
          .menuItem{
            width:100%;
            text-align:left;
            border:0;
            background: transparent;
            color: var(--fg);
            padding: 10px 12px;
            cursor:pointer;
            display:flex;
            flex-direction:column;
            gap:2px;
          }
          .menuItem:hover{
            background: rgba(46,181,255,.14);
          }
          .menuItem .t{font-weight: 900; font-size:12.2px}
          .menuItem .s{font-size:10.8px; color: var(--muted)}
          .menuItem.isActive{
            background: rgba(142,107,255,.16);
          }

          .input{
            display:flex;gap:10px;padding: 12px;
            border-top:1px solid var(--border);
            background: var(--panel);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
          }
          .txt{
            flex:1;min-height: 42px;max-height: 140px;
            padding: 11px 12px;border-radius: 16px;
            border:1px solid var(--border2);
            background: var(--input);
            color: var(--fg);
            resize:none;outline:none;font-size: 12.8px;
            transition: box-shadow .12s ease, border-color .12s ease, background .12s ease;

            overflow: hidden;
          }
          .txt::-webkit-scrollbar{width:0;height:0}
          .txt::placeholder{color: rgba(159,178,202,.72)}
          .palette[data-theme="light"] .txt::placeholder{color: rgba(92,102,125,.70)}
          .txt:focus{
            border-color: rgba(46,181,255,.6);
            box-shadow: 0 0 0 3px var(--accentSoft);
            background: rgba(18,23,36,.82);
          }
          .palette[data-theme="light"] .txt:focus{background: rgba(255,255,255,.92);}

          .send{
            flex:0 0 82px;border:none;border-radius: 16px;
            background: var(--accentGrad);
            color:#fff;font-weight: 900;
            cursor:pointer;
            box-shadow: 0 16px 36px rgba(0,0,0,.28);
            transition: transform .12s ease, opacity .12s ease;
            font-size: 12.6px;
          }
          .send:hover{transform: translateY(-1px)}
          .send:active{transform: translateY(0); opacity:.93}
          .send:disabled{opacity:.65;cursor:not-allowed;transform:none;box-shadow:none}

          .launcher{
            position:fixed;right:22px;bottom:22px;
            z-index:2147483647;
            opacity: 0;
            transform: translateY(8px) scale(.98);
            pointer-events:none;
            transition: transform .18s ease, opacity .18s ease;
          }
          .launcher.isVisible{
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events:auto;
          }
          .launcher button{
            width:62px;height:62px;border-radius: 22px;
            border:1px solid rgba(255,255,255,.20);
            background: var(--accentGrad);
            color:#fff;
            font-size: 13px;
            font-weight: 900;
            cursor:pointer;
            box-shadow: var(--shadow);
            display:flex;align-items:center;justify-content:center;
          }
            /* --- Mobile fix: safe-area + better sizing --- */
          :host{
            --safe-b: env(safe-area-inset-bottom, 0px);
            --safe-t: env(safe-area-inset-top, 0px);
            --safe-r: env(safe-area-inset-right, 0px);
            --safe-l: env(safe-area-inset-left, 0px);
          }

          /* keep away from iPhone home-indicator / notches */
          .wrap{ right: calc(22px + var(--safe-r)); bottom: calc(90px + var(--safe-b)); }
          .launcher{ right: calc(22px + var(--safe-r)); bottom: calc(22px + var(--safe-b)); }

          /* Small screens: make it “bottom sheet” style */
          @media (max-width: 560px){
            .wrap{
              left: calc(12px + var(--safe-l));
              right: calc(12px + var(--safe-r));
              width: auto;
              max-width: none;

              /* stay above the launcher button */
              bottom: calc(88px + var(--safe-b));

              /* IMPORTANT: don’t force 520px min-height on mobile */
              height: min(72svh, 620px);
              border-radius: 18px;
            }

            .launcher{
              right: calc(14px + var(--safe-r));
              bottom: calc(14px + var(--safe-b));
            }
          }

          /* Short phones (or landscape): avoid cutting off */
          @media (max-height: 700px){
            .wrap{ height: min(68svh, 560px); }
          }

          /* When keyboard opens: make panel fill the view safely */
          .wrap.isKeyboard{
            top: calc(12px + var(--safe-t));
            bottom: calc(12px + var(--safe-b));
            height: auto;
          }

        </style>

        <div class="palette" data-theme="dark">
          <div class="wrap" id="panel" role="dialog" aria-label="AI chat">
            <div class="header">
              <div class="brand" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M7 7c0-2 2-4 5-4s5 2 5 4" stroke="white" stroke-width="2" stroke-linecap="round"/>
                  <path d="M6 10h12l-1 10H7L6 10Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
                </svg>
              </div>

              <div class="title-row">
                <div class="title">${TEXT.title}</div>
                <div class="subtitle">
                  <span class="dot"></span>
                  <span>${TEXT.online}</span>
                </div>
              </div>

              <div class="actions">
                <button class="iconBtn" id="themeBtn" type="button" title="Téma" aria-label="Téma"><span aria-hidden="true">☀️</span></button>
                <button class="iconBtn" id="resetBtn" type="button" title="Törlés" aria-label="Törlés"><span aria-hidden="true">🗑️</span></button>
                <button class="iconBtn closeBtn" id="closeBtn" type="button" title="Bezárás" aria-label="Bezárás">×</button>
              </div>
            </div>

            <div class="msgs" id="msgs" aria-live="polite"></div>

            <div class="topicbar" id="topicBar" style="display:none;">
              <button class="topicSelect" id="topicSelect" type="button" aria-haspopup="true" aria-expanded="false">
                <span class="topicLeft">
                  <span class="topicDot"></span>
                  <span class="topicText" id="topicText"></span>
                </span>
                <span class="caret">▾</span>
              </button>

              <div class="topicMenu" id="topicMenu" hidden></div>
            </div>

            <div class="input">
              <textarea class="txt" id="input" placeholder="${TEXT.placeholderDisabled}" disabled></textarea>
              <button class="send" id="send" type="button" disabled>${TEXT.send}</button>
            </div>
          </div>

          <div class="launcher" id="launcher">
            <button type="button">${TEXT.launcher}</button>
          </div>
        </div>
      `;
    }

    cacheNodes(){
      const root = this.shadow;
      const getById = root.getElementById
        ? root.getElementById.bind(root)
        : (id) => root.querySelector(`#${id}`);
      const nodes = {
        palette: root.querySelector('.palette'),
        panel: getById('panel'),
        launcher: getById('launcher'),
        themeBtn: getById('themeBtn'),
        resetBtn: getById('resetBtn'),
        closeBtn: getById('closeBtn'),
        msgs: getById('msgs'),
        input: getById('input'),
        send: getById('send'),
        topicBar: getById('topicBar'),
        topicSelect: getById('topicSelect'),
        topicText: getById('topicText'),
        topicMenu: getById('topicMenu'),
      };
      if (!nodes.panel || !nodes.input || !nodes.send || !nodes.msgs) {
        console.error("[Luna] Chatbot UI failed to mount (missing nodes).");
      }
      return nodes;
    }

    bindEvents(){

      // --- Mobile keyboard handling ---
      this.nodes.input.addEventListener("focus", () => {
        this.nodes.panel.classList.add("isKeyboard");
        this.scrollToBottom?.();
      });
      this.nodes.input.addEventListener("blur", () => {
        this.nodes.panel.classList.remove("isKeyboard");
      });


      this.nodes.themeBtn.addEventListener('click', () => this.toggleTheme());
      this.nodes.resetBtn.addEventListener('click', () => this.resetChat());

      this.nodes.closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._closing) return;
        this._closing = true;
        this.setPanelVisible(false);
        setTimeout(() => { this._closing = false; }, 120); // ~transition idő
      });

      this.nodes.launcher.addEventListener('click', () => this.setPanelVisible(true));

      this.nodes.input.addEventListener('input', () => this.autoResize());

      // ✅ dropdown toggle
      this.nodes.topicSelect.addEventListener("click", () => this.toggleTopicMenu());

      // close on outside click
      document.addEventListener("pointerdown", (e) => {
        if (!this.topicMenuOpen) return;
        const path = e.composedPath?.() || [];
        if (!path.includes(this.nodes.topicBar)) this.closeTopicMenu();
      }, true);

      // close on ESC
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.topicMenuOpen) this.closeTopicMenu();
      });

      this.nodes.input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (this.isSending) return;
          if (this.applySpamBlockIfNeeded(false)) return;

          this.isSending = true;
          this.setInputEnabled(false);
          try { await this.handleSend(); }
          finally {
            this.isSending = false;
            this.setInputEnabled(true);
            this.nodes.input.focus();
          }
        }
      });

      this.nodes.send.addEventListener('click', async () => {
        if (this.isSending) return;
        if (this.applySpamBlockIfNeeded(false)) return;

        this.isSending = true;
        this.setInputEnabled(false);
        try { await this.handleSend(); }
        finally {
          this.isSending = false;
          this.setInputEnabled(true);
          this.nodes.input.focus();
        }
      });
    }

    // ===== UI helpers =====
    setPanelVisible(show){
      if (show) {
        this.nodes.launcher.classList.remove("isVisible");
        this.nodes.panel.classList.remove("isHidden");
        setTimeout(() => {
      this.nodes.input.focus();
          this.scrollToEnd();
        }, 10);
      } else {
        this.nodes.panel.classList.add("isHidden");
        setTimeout(() => this.nodes.launcher.classList.add("isVisible"), 120);
      }
    }

    scrollToEnd(){
      const el = this.nodes.msgs;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      });
    }

    autoResize(){
      const el = this.nodes.input;
      el.style.height = 'auto';
      el.style.height = `${Math.min(Math.max(el.scrollHeight,42),140)}px`;
    }

    getCategoryLabel(key){
      const found = CATEGORIES.find(c => c.key === key);
      return found ? found.label : null;
    }

    updateTopicUi(){
      this.nodes.topicBar.style.display = 'none';

      // 🔒 lock UI, ha válaszol
      const locked = !!this.isSending;
      this.nodes.topicSelect.classList.toggle("isLocked", locked);
      this.nodes.topicSelect.setAttribute("aria-disabled", locked ? "true" : "false");
      if (locked) this.closeTopicMenu();

      this.renderTopicMenu();
    }

    setInputEnabled(enabled){
      const st = readSpamState();
      const blocked = st.blockedUntil && nowMs() < st.blockedUntil;
      const finalEnabled = enabled && !blocked;

      this.nodes.input.disabled = !finalEnabled;
      this.nodes.send.disabled = !finalEnabled;

      if (finalEnabled) {
        this.nodes.input.placeholder = "Írd be a kérdésed…";
      } else {
        if (blocked) {
          const leftSec = msToSecCeil(st.blockedUntil - nowMs());
          this.nodes.input.placeholder = TEXT.spamBlocked(leftSec);
        } else {
          this.nodes.input.placeholder = TEXT.placeholderDisabled;
        }
      }

      this.updateTopicUi();
    }

    startCategoryGate(){
      this.selectedCategory = DEFAULT_CATEGORY;
      safeRemove(CONFIG.categoryKey);
      this.setInputEnabled(false);
      this.updateTopicUi();
    }

    // ===== Theme =====
    initTheme(){
      const saved = safeRead(CONFIG.themeKey);
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      this.nodes.palette.dataset.theme = theme;
      this.nodes.themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
      this.nodes.launcher.classList.remove("isVisible");
    }

    createShadowRoot(host){
      if (!host || !host.attachShadow) return host;
      try {
        return host.attachShadow({ mode: "open" });
      } catch (err) {
        console.warn("[Luna] Shadow DOM not available, using light DOM.", err);
        return host;
      }
    }

    toggleTheme(){
      const current = this.nodes.palette.dataset.theme === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      this.nodes.palette.dataset.theme = next;
      this.nodes.themeBtn.textContent = next === "dark" ? "☀️" : "🌙";
      safeWrite(CONFIG.themeKey, next);
    }

    // ===== History =====
    restoreHistory(){
      try {
        const raw = localStorage.getItem(CONFIG.historyKey);
        if(raw) this.history = JSON.parse(raw) || [];
      } catch { this.history = []; }
    }

    persistHistory(){
      try { localStorage.setItem(CONFIG.historyKey, JSON.stringify(this.history.slice(-50))); } catch {}
    }

    addMessage(role, text, opts={}){
      const ts = opts.ts || nowMs();

      const row = document.createElement('div');
      row.className = `row ${role === 'user' ? 'user' : 'bot'}`;

      if (role !== 'user') {
        const avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 3a7 7 0 0 0-7 7v1a7 7 0 0 0 14 0v-1a7 7 0 0 0-7-7Z" stroke="white" stroke-width="2"/>
            <path d="M7 20c1.5-2 3.5-3 5-3s3.5 1 5 3" stroke="white" stroke-width="2" stroke-linecap="round"/>
          </svg>
        `;
        row.appendChild(avatar);
      }

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (opts.typing) bubble.classList.add("isTyping");
      if (opts.html) bubble.innerHTML = opts.html;
      else bubble.textContent = text;

      row.appendChild(bubble);
      this.nodes.msgs.appendChild(row);

      if(role === 'user'){
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = timeFormatter.format(new Date(ts));
        row.appendChild(meta);
      }

      if(opts.persist !== false){
        this.history.push({role, text: (opts.persistText ?? text), ts});
        this.persistHistory();
      }

      this.scrollToEnd();
    }

    addBot(text, opts){ this.addMessage('bot', text, opts); }
    addUser(text){ this.addMessage('user', text); }

    updateLastBotBubble(text) {
      const bubbles = this.nodes.msgs.querySelectorAll(".row.bot .bubble");
      const last = bubbles[bubbles.length - 1];
      if (last) {
        last.classList.remove("isTyping");
        last.textContent = text;
      }

      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].role === "bot") {
          this.history[i].text = text;
          break;
        }
      }
      this.persistHistory();
      this.scrollToEnd();
    }

    // ===== Topic dropdown =====
    renderTopicMenu(){
      this.nodes.topicMenu.hidden = true;
      this.topicMenuOpen = false;
      this.nodes.topicSelect.setAttribute("aria-expanded", "false");
      this.nodes.topicMenu.innerHTML = "";
    }

    toggleTopicMenu(){
      return;
    }

    openTopicMenu(){
      return;
    }

    closeTopicMenu(){
      this.topicMenuOpen = false;
      this.nodes.topicMenu.hidden = true;
      this.nodes.topicSelect.setAttribute("aria-expanded", "false");
    }

    switchCategoryFromMenu(key){
      return;
    }

    // ===== Category cards (kezdeti választás) =====
    showCategoryOptions(){
      return;
    }

    hideCategoryOptions(){
      if (this.categoryRowEl) {
        this.categoryRowEl.remove();
        this.categoryRowEl = null;
      }
    }

    handleCategoryPick(cat){
      return;
    }

    renderHistory(){
      this.nodes.msgs.innerHTML = '';
      this.hideCategoryOptions();
      this.history.forEach(msg => this.addMessage(msg.role, msg.text, {ts: msg.ts, persist:false}));
      this.scrollToEnd();
    }

    resetChat(){
      this.history = [];
      safeRemove(CONFIG.historyKey);

      this.hideCategoryOptions();
      this.nodes.msgs.innerHTML = '';

      this.addBot(TEXT.greet, {persist:false});
      this.setInputEnabled(true);
      this.scrollToEnd();
    }

    // ===== Spam =====
    applySpamBlockIfNeeded(isStartup){
      const st = readSpamState();
      const now = nowMs();

      if (st.blockedUntil && now < st.blockedUntil) {
        const leftSec = msToSecCeil(st.blockedUntil - now);
        this.setInputEnabled(true);

        if (!isStartup) this.addBot(TEXT.spamBlocked(leftSec), {persist:true});

        clearTimeout(this.blockTimer);
        this.blockTimer = setTimeout(() => {
          this.setInputEnabled(true);
        }, (st.blockedUntil - now) + 30);

        return true;
      }
      return false;
    }

    registerUserSendForSpam(){
      const st = readSpamState();
      const now = nowMs();

      const cutoff = now - SPAM.windowMs;
      const sent = (st.sent || []).filter(t => t >= cutoff);
      sent.push(now);

      if (sent.length > SPAM.maxInWindow) {
        const blockedUntil = now + SPAM.blockMs;
        writeSpamState({ blockedUntil, sent });

        const leftSec = msToSecCeil(SPAM.blockMs);
        this.setInputEnabled(false);
        this.addBot(TEXT.spamBlocked(leftSec), {persist:true});

        clearTimeout(this.blockTimer);
        this.blockTimer = setTimeout(() => {
          const st2 = readSpamState();
          st2.blockedUntil = 0;
          writeSpamState(st2);
          this.setInputEnabled(true);
        }, SPAM.blockMs + 30);

        return false;
      }

      writeSpamState({ blockedUntil: st.blockedUntil || 0, sent });
      return true;
    }

    // ===== Send =====
    async handleSend(){
      const question = (this.nodes.input.value || '').trim();
      if(!question) return;

      if (this.applySpamBlockIfNeeded(false)) return;
      if (!this.registerUserSendForSpam()) return;

      this.nodes.input.value = '';
      this.autoResize();

      if(isOffTopic(question)){
        this.addUser(question);
        this.addBot(TEXT.offTopic);
        return;
      }

      // ✅ BÖNGÉSZŐ KONZOL LOG (kérdés)
      console.log(`[Luna] Q ->`, question);

      this.addUser(question);

      // typing bubble (1 db)
      this.addBot("", {
        persist: true,
        typing: true,
        html: `<span class="typingDots" aria-label="Éppen ír"><span></span><span></span><span></span></span>`,
        persistText: ""
      });

      const historyForServer = this.history
        .slice(-12)
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.text
        }));

      try {
        const reply = await this.fetchReplyStream(question, historyForServer);

        if (!reply) {
          this.updateLastBotBubble(TEXT.empty);
          console.log(`[Luna] A ->`, TEXT.empty);
        } else {
          // ✅ BÖNGÉSZŐ KONZOL LOG (válasz)
          console.log(`[Luna] A ->`, reply);
        }
      } catch (err) {
        if (err?.kind === "RATE_LIMIT") {
          const s = err.retryAfterSec || 3;
          this.updateLastBotBubble(TEXT.rateLimit(s));
          console.log(`[Luna] A (rate-limit) ->`, TEXT.rateLimit(s));
        } else if (err?.kind === "BUSY") {
          this.updateLastBotBubble(TEXT.busy);
          console.log(`[Luna] A (busy) ->`, TEXT.busy);
        } else {
          console.error("Frontend hiba (stream):", err);
          this.updateLastBotBubble(TEXT.networkError);
          console.log(`[Luna] A (error) ->`, TEXT.networkError);
        }
      } finally {
        this.setInputEnabled(true);
        this.scrollToEnd();
      }
    }

    async fetchReplyStream(question, historyForServer) {
      this.abortController?.abort();
      this.abortController = new AbortController();

      const response = await fetch(CONFIG.endpointStream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          history: historyForServer,
          category: this.selectedCategory,
          clientId: getOrCreateClientId(),
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retry = parseInt(response.headers.get("Retry-After") || "0", 10);
          const e = new Error("RATE_LIMIT");
          e.kind = "RATE_LIMIT";
          e.retryAfterSec = Number.isFinite(retry) && retry > 0 ? retry : 3;
          throw e;
        }
        if (response.status === 409) {
          const e = new Error("BUSY");
          e.kind = "BUSY";
          throw e;
        }
        throw new Error("HTTP " + response.status);
      }


      const ct = (response.headers.get("content-type") || "").toLowerCase();
      // If the backend is NOT streaming (regular JSON), handle it here.
      if (!ct.includes("text/event-stream")) {
        const raw = await response.text();
        let payload = null;
        try { payload = JSON.parse(raw); } catch {}

        const answer =
          (payload && (payload.answer ?? payload.text ?? payload.output ?? payload.response)) || "";

        if (answer) {
          this.updateLastBotBubble(String(answer));
          return String(answer).trim();
        }

        const msg = (payload && (payload.message || payload.error)) || raw || "";
        if (msg) this.updateLastBotBubble(String(msg));
        return String(msg).trim();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let done = false;
      let fullText = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (!value) continue;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") { done = true; break; }

          const parsed = JSON.parse(data);
          const delta = parsed.delta || "";
          if (!delta) continue;

          fullText += delta;
          this.updateLastBotBubble(fullText);
        }
      }

      return fullText.trim();
    }
  }

  function createHost(){
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.right = '0';
    host.style.bottom = '0';
    host.style.zIndex = '2147483647';
    host.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    host.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    host.addEventListener("click", (e) => e.stopPropagation(), true);
    document.body.appendChild(host);
    return host;
  }

  function waitForBody(ready){
    if (document.body) return ready();
    requestAnimationFrame(() => waitForBody(ready));
  }

  function bootstrap(){
    waitForBody(() => {
      try { new RestaurantChatbot(); }
      catch (err) { console.error("[Luna] Chatbot bootstrap failed:", err); }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bootstrap, {once:true});
  } else {
    bootstrap();
  }
})();
