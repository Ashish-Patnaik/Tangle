const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmt = new Intl.NumberFormat("en-US");
const pct = (n) => `${Math.round(n * 100)}%`;
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const state = { repos: [], repo: null, result: null };

// The single in-flight animation frame for the dependency map.
//
// drawGraph is called from three places - once after an analysis, once from
// route(), and once every time the map tab is clicked - and each call used to
// start its own requestAnimationFrame loop. Nothing ever stopped the previous
// one, so clicking the map tab a few times left several O(n^2) force passes
// running at once on the same node positions. That is what made the map hang:
// the physics got heavier the more it was clicked, not smoother.
//
// One handle, cancelled before every new loop, so there is never more than one.
let mapFrame = 0;

function route() {
  const isApp = (location.hash || "#/").startsWith("#/app");
  $("#view-landing").hidden = isApp;
  $("#view-app").hidden = !isApp;
  
  if (isApp) {
    const pending = sessionStorage.getItem("tangle.pendingInput");
    if (pending) {
      console.log("[Tangle] Found pending input from landing page:", pending);
      sessionStorage.removeItem("tangle.pendingInput");
      $("#input").value = pending;
      analyse();
    }
    if (state.result) requestAnimationFrame(() => drawGraph(state.result));
  }
  
  if (!/^#[a-z]/.test(location.hash)) window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

boot().catch((e) => { 
  console.error("[Tangle] Fatal Boot Error:", e);
  const st = $("#status"); if (st) { st.textContent = e?.message ?? e; } 
});

async function boot() {
  console.log("[Tangle] Booting application...");
  wireTabs();
  
  $("#heroForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#heroInput").value.trim();
    if (!v) { toast("Please paste a PR link first"); return; }
    sessionStorage.setItem("tangle.pendingInput", v);
    location.hash = "#/app";
    if (location.hash === "#/app") route(); // Force execution if hash was already #/app
  });
  
  const conf = $("#conf"), hops = $("#hops");
  const sync = () => {
    $("#confOut").textContent = `${conf.value}%`;
    $("#hopsOut").textContent = `${hops.value} step${hops.value > 1 ? "s" : ""}`;
  };
  conf.addEventListener("input", sync);
  hops.addEventListener("input", sync);
  sync();
  
  $("#go").addEventListener("click", analyse);
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter") analyse(); });

  // Floating Nav Scroll Reaction (Hide on scroll down, show on scroll up)
  let lastScroll = 0;
  window.addEventListener("scroll", () => {
    const nav = $("#main-nav");
    if (!nav) return;
    
    const currentScroll = window.scrollY;
    
    // Add styling class for slight shrink
    if (currentScroll > 20) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");

    // Hide if scrolling down past 100px, show if scrolling up
    if (currentScroll > lastScroll && currentScroll > 100) {
      nav.classList.add("nav-hidden");
    } else {
      nav.classList.remove("nav-hidden");
    }
    
    lastScroll = currentScroll;
  });

  await loadRepos();
  renderChips();
  route();
}

async function loadRepos() {
  // No dropdown: the repo comes from the PR link. This only picks a default
  // for bare file lists and fills the sidebar stats if something is ingested.
  try {
    const data = await fetch("/api/repos").then((r) => r.json());
    state.repos = data.repos ?? [];
    state.repo = state.repos.find((r) => r.primary && r.ingested)?.id
      ?? state.repos.find((r) => r.ingested)?.id ?? data.default;
  } catch (error) {
    console.error("[Tangle] Failed to load repositories. Is the API server running?", error);
  }
}

function renderChips() {
  const presets = [
    { files: "packages/next/src/server/config.ts,packages/next/src/server/lib/router-utils/resolve-routes.ts", label: "Next.js config + routes" },
    { files: ".github/workflows/code_freeze.yml,.github/workflows/trigger_release.yml", label: "release workflows" },
    { files: "index.js,test.js", label: "slugify demo" },
  ];
  const html = presets.map((p) => `<button class="chip" data-files="${esc(p.files)}" title="${esc(p.files)}">${esc(p.label)}</button>`).join("");
  
  if ($("#heroChips")) $("#heroChips").innerHTML = html;
  if ($("#examples")) $("#examples").innerHTML = html;
  
  for (const chip of $$(".chip")) {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      const v = chip.dataset.files;
      console.log(`[Tangle] Preset chip clicked: ${v}`);
      if (!$("#view-app").hidden) { 
        $("#input").value = v; 
        analyse(); 
      } else { 
        $("#heroInput").value = v; 
        sessionStorage.setItem("tangle.pendingInput", v); 
        location.hash = "#/app"; 
        route(); 
      }
    });
  }
}

async function showSideStats() {
  const box = $("#sideStats");
  if (!state.repo) return;
  box.innerHTML = `<div class="stat-row"><b>...</b><span>loading</span></div>`;
  console.log(`[Tangle] Fetching stats for ${state.repo}...`);
  try {
    const d = await fetch(`/api/repos/${encodeURIComponent(state.repo)}/stats`).then((r) => r.json());
    if (d.error || !d.totals) { 
      console.warn(`[Tangle] Stats returned error or no totals:`, d);
      box.innerHTML = ""; 
      return; 
    }
    const t = d.totals;
    const cells = [
      [fmt.format(t.files), "Files Mapped"], 
      [fmt.format(t.couplingEdges), "Historical Links"],
      [fmt.format(t.commits), "Commits Mined"]
    ];
    box.innerHTML = cells.map(([b, s]) => `<div class="stat-row"><span>${esc(s)}</span><b>${esc(String(b))}</b></div>`).join("");
    console.log(`[Tangle] Stats updated successfully.`);
  } catch (err) { 
    console.error("[Tangle] Failed to fetch stats:", err);
    box.innerHTML = ""; 
  }
}

async function analyse() {
  const input = $("#input").value.trim();
  if (!input) { toast("Paste a PR link or file names first"); return; }
  
  const btn = $("#go");
  btn.disabled = true;
  const st = $("#status");
  st.textContent = "Querying FalkorDB Graph...";
  st.className = "status-text";
  
  console.log(`[Tangle] Starting analysis for input: ${input}`);
  
  try {
    const payload = {
      pr: input, 
      repo: state.repo,
      minConfidence: Number($("#conf").value) / 100,
      maxHops: Number($("#hops").value),
    };
    
    console.log("[Tangle] Analysis Payload:", payload);

    const call = async () => {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({ error: `Server returned ${r.status}` }));
      return { status: r.status, body };
    };

    // On-demand ingest: the server answers 202 while it clones + loads an
    // unseen repo. Poll until the graph exists, then the same call succeeds.
    let { status, body: res } = await call();
    const t0 = Date.now();
    while (status === 202) {
      const secs = Math.round((Date.now() - t0) / 1000);
      st.textContent = `Ingesting ${res.repo} into FalkorDB (first use): ${res.phase || "starting"}... ${secs}s`;
      if (secs > 1800) throw new Error("Ingest is taking too long. Try again shortly.");
      await new Promise((ok) => setTimeout(ok, 3000));
      ({ status, body: res } = await call());
    }

    if (res.error) {
      console.error("[Tangle] Analysis API Error:", res.error);
      st.textContent = "Error: " + res.error;
      st.className = "status-text error";
      return;
    }

    console.log("[Tangle] Analysis Result:", res);
    state.result = res;
    state.repo = res.repo;
    $("#repoBlurb").textContent = res.repo;
    showSideStats();
    
    const ms = Math.round(res.timings?.total ?? 0);
    st.textContent = `Analysis complete. Processed in ${ms}ms.` + ((res.degraded ?? []).length ? ` Note: ${res.degraded[0]}` : "");
    
    $("#emptyDash").hidden = true;
    $("#results").hidden = false;
    $("#summary").hidden = false;
    
    $("#sumChanged").textContent = String(res.query.changedFiles.length);
    $("#sumRisk").textContent = String(res.blastRadius.length);
    $("#sumMissed").textContent = String((res.missed ?? []).length);
    $("#sumMs").textContent = `${ms}ms`;
    
    renderRiskScore(res);
    renderRisk(res);
    renderForgot(res);
    renderChecked(res);
    drawGraph(res);
    
    activateTab(res.blastRadius.length === 0 && (res.missed ?? []).length > 0 ? "forgot" : "risk");
    await showDashboardLinks();
    
  } catch (e) {
    console.error("[Tangle] Fatal error during analysis request:", e);
    st.textContent = e instanceof Error ? e.message : String(e);
    st.className = "status-text error";
  } finally { 
    btn.disabled = false; 
  }
}

function renderRiskScore(res) {
  const box = $("#riskPanel");
  const r = res.risk;
  if (!box || !r) { if (box) box.hidden = true; return; }
  const color = { low: "#008A50", medium: "#F5A623", high: "#FF7043", critical: "#E5484D" }[r.level] ?? "#1A1514";
  const bars = r.factors.map((f) => `
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px;">
      <span style="width:46px;font-weight:700;">${f.points}/${f.max}</span>
      <div style="flex:0 0 120px;height:8px;background:#eee;border-radius:4px;overflow:hidden;"><div style="width:${Math.round(f.points / f.max * 100)}%;height:100%;background:${color};"></div></div>
      <span>${esc(f.detail)}</span>
    </div>`).join("");
  box.hidden = false;
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
      <div style="font-size:44px;font-weight:800;color:${color};line-height:1;">${r.score}<span style="font-size:16px;color:#777;">/100</span></div>
      <div><div style="font-weight:800;text-transform:uppercase;color:${color};">${esc(r.level)} merge risk</div>
      <div style="font-size:12px;color:#777;max-width:520px;">${esc(r.caveat)}</div></div>
    </div>
    <div style="margin-top:10px;">${bars}</div>
    <div style="margin-top:10px;font-weight:700;">Suggested next steps</div>
    <ul style="margin:4px 0 0 18px;font-size:13px;">${r.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
}

const meter = (conf) => `<div class="meter-bg"><div class="meter-fill" style="width:${Math.round(conf * 100)}%"></div></div>`;

function renderRisk(res) {
  $("#radiusCount").textContent = res.blastRadius.length ? `(${res.blastRadius.length})` : "";
  
  const rList = $("#radiusList");
  if (res.blastRadius.length === 0) {
    rList.innerHTML = `<div class="data-row"><span class="row-badge" style="background:#E6FFF0;color:#008A50;">SAFE</span><div><div class="row-path">Clear to merge.</div><div class="row-meta">Nothing crosses your strictness threshold. See 'The Math' for proof.</div></div></div>`;
  } else {
    rList.innerHTML = res.blastRadius.slice(0, 60).map((f) => {
      const isWarn = f.confidence >= 0.5;
      return `
      <div class="data-row ${isWarn ? "warning" : ""}">
        <span class="row-badge">${pct(f.confidence)}</span>
        <div>
          <div class="row-path">${esc(f.path)}</div>
          ${meter(f.confidence)}
          <div class="row-meta">${f.hops} steps away · Co-changed ${fmt.format(f.coChanges)} times${f.evidence?.length ? ` (e.g. ${esc(f.evidence[0].slice(0, 7))})` : ""}</div>
        </div>
      </div>`;
    }).join("");
  }
      
  const vList = $("#reviewerList");
  if ((res.reviewers ?? []).length === 0) {
    vList.innerHTML = `<div class="data-row"><span class="row-badge">—</span><div><div class="row-path">No clear owner found in history.</div></div></div>`;
  } else {
    vList.innerHTML = res.reviewers.map((r) => {
      const initials = r.login.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase() || "??";
      return `<div class="data-row">
        <span class="row-badge">${pct(r.affinity)}</span>
        <div>
          <div class="row-path" style="display:flex; align-items:center; gap:8px;">
              <span style="background:#FF7043;color:#FFF;padding:2px 6px;border-radius:4px;font-size:11px;">${esc(initials)}</span>
              @${esc(r.login)}
          </div>
          ${meter(r.affinity)}
          <div class="row-meta">${fmt.format(r.commits)} commits mapping to affected files</div>
        </div>
      </div>`;
    }).join("");
  }
}

function renderForgot(res) {
  const missed = res.missed ?? [];
  const intro = $("#missedIntro");
  
  if (missed.length === 0) {
    intro.className = "alert-box safe";
    intro.innerHTML = "<strong>Looking good.</strong> We didn't find any missing files that usually ship with this code.";
  } else {
    intro.className = "alert-box";
    intro.innerHTML = `<strong>⚠️ ${missed.length} file(s) are usually included with these changes!</strong> Take a second look.`;
  }
    
  $("#missedList").innerHTML = missed.map((m) => `
    <div class="data-row danger">
      <span class="row-badge" style="background:#FCE8E8;color:#E5484D;">${pct(m.confidence)}</span>
      <div>
        <div class="row-path">${esc(m.path)}</div>
        ${meter(m.confidence)}
        <div class="row-meta">${esc(m.rationale ?? "")}</div>
      </div>
    </div>`).join("");
}

function renderChecked(res) {
  const c = res.certificate;
  const rows = [
    ["Files inside repo", fmt.format(c.search.repoFilesTotal)],
    ["Files analyzed", `${fmt.format(c.search.filesReached)} (${c.coverage.filesConsideredPct}%)`],
    ["Links in DB", fmt.format(c.search.couplingEdgesTotal)],
    ["Links scanned", `${fmt.format(c.search.edgesScanned)} (${c.coverage.edgesConsideredPct}%)`],
    ["Strictness Threshold", `${c.parameters.minConfidence * 100}% Confidence`],
    ["Max Search Depth", `${c.parameters.maxHops} Hops`],
  ];
  
  $("#certificate").innerHTML = `
    <div class="cert-stat">"${esc(c.statement)}"</div>
    <table class="cert-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>`;
    
  $("#cypherList").innerHTML = (c.methods ?? []).map((m) => `<div style="margin:16px 0 8px;font-weight:700;color:var(--ink);">${esc(m.label)}</div><pre>${esc(m.cypher)}</pre>`).join("");
}

async function showDashboardLinks() {
  if (!state.repo || $("#view-app").hidden) return;
  const list = $("#discoverList");
  list.innerHTML = `<div class="data-row"><span class="row-badge">...</span><div><div class="row-path">Mining graph for secrets...</div></div></div>`;
  
  console.log(`[Tangle] Fetching discoveries (hidden couplings) for ${state.repo}...`);
  try {
    const d = await fetch(`/api/repos/${encodeURIComponent(state.repo)}/discoveries?limit=12&minConfidence=0.5&minCoChanges=5`).then((r) => r.json());
    console.log(`[Tangle] Discoveries received:`, d);
    
    const pairs = d.phantom ?? [];
    $("#discoverMeta").textContent = d.counts ? `Found ${fmt.format(d.counts.phantomFound ?? pairs.length)} connections in ${d.ms}ms` : "";
    
    if (pairs.length === 0) {
      list.innerHTML = `<div class="data-row"><span class="row-badge">—</span><div><div class="row-path">No hidden links cross the bar.</div></div></div>`;
    } else {
      list.innerHTML = pairs.map((p) => `
        <div class="data-row warning">
          <span class="row-badge" style="background:#FFFDF5;color:#F5A623;">${pct(p.confidence)}</span>
          <div>
            <div class="row-path" style="margin-bottom:2px;">${esc(p.a)}</div>
            <div class="row-path" style="margin-bottom:8px;">${esc(p.b)}</div>
            ${meter(p.confidence)}
            <div class="row-meta">Co-changed ${fmt.format(p.coChanges)}x · <strong style="color:var(--primary-orange);">No explicit code link</strong></div>
          </div>
        </div>`).join("");
    }
  } catch (err) { 
    console.error("[Tangle] Failed to fetch discoveries:", err);
    list.innerHTML = `<div class="data-row"><span class="row-badge error">ERR</span><div><div class="row-path">Failed to load.</div></div></div>`;
  }
}

function wireTabs() {
  for (const tab of $$(".ui-tab")) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }
}

function activateTab(name) {
  for (const t of $$(".ui-tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".tab-body")) p.hidden = p.dataset.panel !== name;
  if (name === "map" && state.result) requestAnimationFrame(() => drawGraph(state.result));
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

// Dependency map.
//
// The layout is solved ONCE, synchronously (<= ~5 ms for the 40-node cap), and
// the canvas is then redrawn only when something changes (hover, pan, zoom,
// resize). There is no continuous animation loop, so there is nothing to pile
// up when the tab is clicked repeatedly and the page can never hang on it.
let mapRedraw = null; // the current map's redraw function, used by the resize handler
let mapQueued = 0;

window.addEventListener("resize", () => { if (mapRedraw && state.result) drawGraph(state.result); });

function drawGraph(res) {
  const canvas = $("#graph");
  if (!canvas || $("#view-app").hidden || !res) return;

  // Cancel any queued paint from a previous render.
  if (mapQueued) { cancelAnimationFrame(mapQueued); mapQueued = 0; }
  if (mapFrame) { cancelAnimationFrame(mapFrame); mapFrame = 0; }

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 700;
  const H = canvas.clientHeight || 500;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const seeds = (res.query?.changedFiles ?? []).slice(0, 6);
  const affected = (res.blastRadius ?? []).slice(0, 34);
  const nodes = [];
  const seen = new Set();

  const push = (path, kind, conf, co) => {
    if (seen.has(path)) return null;
    seen.add(path);
    const i = nodes.length;
    const ang = i * 2.399963; // golden angle: no two nodes start on the same ray
    const rad = kind === "changed" ? 34 : 120 + (i % 7) * 26;
    const n = {
      path, kind, conf, co,
      x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad,
      vx: 0, vy: 0,
      r: kind === "changed" ? 14 : 8 + conf * 10,
    };
    nodes.push(n);
    return n;
  };

  for (const s of seeds) push(s, "changed", 1, 0);
  for (const f of affected) push(f.path, "affected", f.confidence, f.coChanges);

  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const edges = [];
  for (const f of affected) {
    const to = byPath.get(f.path);
    if (!to) continue;
    // nodePath[0] is the seed the traversal actually came through.
    const seedPath = Array.isArray(f.nodePath) && f.nodePath.length >= 2 ? f.nodePath[0] : null;
    const from = seedPath ? byPath.get(seedPath) : null;
    if (from) edges.push({ from, to, conf: f.confidence });
  }

  // ---- layout: fixed iteration count, runs to completion, never yields a loop ----
  for (let it = 0; it < 220; it++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (i - j) * 0.01 + 0.5; dy = 0.5; d2 = 1; } // deterministic nudge
        const d = Math.sqrt(d2);
        const f = 6000 / d2;
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
      a.vx += (W / 2 - a.x) * 0.005;
      a.vy += (H / 2 - a.y) * 0.005;
    }
    for (const e of edges) {
      const k = e.conf * 0.03;
      const dx = e.to.x - e.from.x, dy = e.to.y - e.from.y;
      e.from.vx += dx * k; e.from.vy += dy * k;
      e.to.vx -= dx * k; e.to.vy -= dy * k;
    }
    for (const n of nodes) {
      n.vx *= 0.78; n.vy *= 0.78;
      n.x += Math.max(-15, Math.min(15, n.vx));
      n.y += Math.max(-15, Math.min(15, n.vy));
    }
  }

  // Solved layout becomes the spring target; nodes start bunched near the
  // centre and wobble out to it. Pure per-node arithmetic: O(n), no pair forces.
  for (const n of nodes) {
    n.tx = n.x; n.ty = n.y;
    n.ph = (n.tx * 0.013 + n.ty * 0.017) % (Math.PI * 2);
    n.x = W / 2 + (n.tx - W / 2) * 0.15;
    n.y = H / 2 + (n.ty - H / 2) * 0.15;
    n.vx = 0; n.vy = 0;
  }

  const view = { x: 0, y: 0, s: 1 };
  let drag = null;
  let hover = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toWorld = (p) => ({ x: (p.x - view.x) / view.s, y: (p.y - view.y) / view.s });
  const short = (p) => { const s = p.split("/"); return s.length <= 2 ? p : `.../${s[s.length - 1]}`; };

  function paint() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.s, view.s);

    const tt = performance.now() / 650;
    for (const n of nodes) { // idle wiggle, drawn offset only; never feeds back into positions
      n.dx = Math.sin(tt + n.ph) * 2.6; n.dy = Math.cos(tt * 0.9 + n.ph) * 2.6;
    }
    for (const e of edges) {
      const hot = hover && (hover === e.from || hover === e.to);
      ctx.beginPath();
      ctx.moveTo(e.from.x + e.from.dx, e.from.y + e.from.dy);
      ctx.lineTo(e.to.x + e.to.dx, e.to.y + e.to.dy);
      ctx.strokeStyle = "#1A1514";
      ctx.lineWidth = hot ? 4 : 1.5 + e.conf * 2;
      ctx.stroke();
    }

    const labelled = [];
    for (const n of nodes) {
      const hot = n === hover;
      const r = n.r * (hot ? 1.2 : 1);
      ctx.beginPath();
      ctx.arc(n.x + n.dx + 3, n.y + n.dy + 3, r, 0, Math.PI * 2);
      ctx.fillStyle = "#1A1514";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(n.x + n.dx, n.y + n.dy, r, 0, Math.PI * 2);
      ctx.fillStyle = n.kind === "changed" ? "#FF7043" : "#FFA6C9";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#1A1514";
      ctx.stroke();
      if (hot || n.kind === "changed") labelled.push(n);
    }

    // Labels last so no node paints over them; hovered one on top.
    labelled.sort((a, b) => (a === hover) - (b === hover));
    ctx.font = "800 13px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    for (const n of labelled) {
      const txt = short(n.path);
      const lx = n.x + n.dx, ly = n.y + n.dy;
      const tw = ctx.measureText(txt).width;
      const rr = (x, y, w, h) => {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6); else ctx.rect(x, y, w, h);
      };
      rr(lx - tw / 2 - 5, ly - n.r - 25, tw + 16, 22);
      ctx.fillStyle = "#1A1514"; ctx.fill();
      rr(lx - tw / 2 - 8, ly - n.r - 28, tw + 16, 22);
      ctx.fillStyle = "#FFFFFF"; ctx.fill();
      ctx.strokeStyle = "#1A1514"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#1A1514";
      ctx.fillText(txt, n.x, ly - n.r - 13);
    }
    ctx.restore();
  }
  // One loop per map (the previous one is cancelled at the top of drawGraph).
  // Capped at ~40 fps, stops when the tab/page is hidden or the canvas leaves
  // the DOM, and the spring settles after ~1.5 s so only the cheap bob remains.
  let last = 0, frames = 0;
  function loop(now) {
    mapQueued = 0;
    if (!canvas.isConnected || $("#view-app").hidden || document.hidden || canvas.offsetParent === null) return;
    if (now - last >= 24) {
      last = now;
      if (frames < 90) {
        frames++;
        for (const n of nodes) {
          n.vx = (n.vx + (n.tx - n.x) * 0.09) * 0.8;
          n.vy = (n.vy + (n.ty - n.y) * 0.09) * 0.8;
          n.x += n.vx; n.y += n.vy;
        }
      }
      paint();
    }
    mapQueued = requestAnimationFrame(loop);
  }
  const schedule = () => { if (!mapQueued) mapQueued = requestAnimationFrame(loop); };
  mapRedraw = schedule;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); }, { once: true });

  canvas.onpointerdown = (e) => { drag = { p: pos(e), o: { ...view } }; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = (e) => {
    const p = pos(e);
    if (drag) { view.x = drag.o.x + (p.x - drag.p.x); view.y = drag.o.y + (p.y - drag.p.y); schedule(); return; }
    const w = toWorld(p);
    const next = nodes.find((n) => Math.hypot(n.x - w.x, n.y - w.y) < n.r + 6) ?? null;
    canvas.style.cursor = next ? "pointer" : "grab";
    if (next !== hover) { hover = next; schedule(); }
  };
  canvas.onpointerup = () => { drag = null; canvas.style.cursor = "grab"; };
  canvas.onpointerleave = () => { if (hover) { hover = null; schedule(); } };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const p = pos(e);
    const before = toWorld(p);
    view.s = Math.min(3, Math.max(0.4, view.s * (e.deltaY > 0 ? 0.9 : 1.1)));
    view.x += (toWorld(p).x - before.x) * view.s;
    view.y += (toWorld(p).y - before.y) * view.s;
    schedule();
  };

  schedule();
}
