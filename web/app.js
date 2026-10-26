/* FinStream 前端逻辑：SSE 接收行情 → 渲染概览卡片 / 行情列表 / 分时图。 */
(() => {
  "use strict";

  const MARKETS = ["全部", "指数", "A股", "美股", "港股", "外汇", "商品", "加密"];
  const MAX_POINTS = 720;

  const state = {
    quotes: new Map(),
    order: [],
    selected: null,
    history: [],
    filter: "全部",
    sortKey: "changePct",
    sortDir: "desc",
    query: "",
    serverTime: 0,
    hasData: false,
  };

  const el = {};

  // ---------------------------------------------------------------- 工具函数

  const $_ = (id) => document.getElementById(id);

  function dirClass(v) {
    if (v > 0) return "up";
    if (v < 0) return "down";
    return "flat";
  }

  function fmt(value, digits = 2) {
    if (!Number.isFinite(value)) return "--";
    return Number(value).toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function signed(value, digits = 2) {
    if (!Number.isFinite(value)) return "--";
    const text = Number(value).toFixed(digits);
    return value > 0 ? `+${text}` : text;
  }

  function fmtPrice(q) {
    return q ? fmt(q.price, q.decimals) : "--";
  }

  function fmtVolume(v) {
    if (!Number.isFinite(v) || v <= 0) return "—";
    if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
    return Math.round(v).toLocaleString("zh-CN");
  }

  function hhmm(ms) {
    return new Date(ms).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function hhmmss(ms) {
    return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sparkSvg(quote, width, height) {
    const pts = quote.spark || [];
    if (pts.length < 2) return "";
    const w = width || 76;
    const h = height || 24;
    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      if (p < min) min = p;
      if (p > max) max = p;
    }
    const span = max - min || 1;
    const step = w / (pts.length - 1);
    const coords = pts
      .map((p, i) => {
        const px = (i * step).toFixed(2);
        const py = (h - 2 - ((p - min) / span) * (h - 4)).toFixed(2);
        return `${px},${py}`;
      })
      .join(" ");
    const color = quote.changePct >= 0 ? "#ff5b6a" : "#22c98b";
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${coords}" fill="none" stroke="${color}" stroke-width="1.4"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>`;
  }

  // ---------------------------------------------------------------- 数据入口

  function applyPayload(payload) {
    if (!payload || !Array.isArray(payload.quotes) || !payload.quotes.length) return;

    const firstLoad = !state.hasData;
    state.hasData = true;
    state.serverTime = payload.serverTime || Date.now();
    state.quotes.clear();
    state.order = payload.quotes.map((q) => q.symbol);
    for (const q of payload.quotes) state.quotes.set(q.symbol, q);

    if (!state.selected || !state.quotes.has(state.selected)) {
      const preferred = payload.quotes.find((q) => q.market === "指数") || payload.quotes[0];
      select(preferred.symbol);
    } else if (state.history.length > 1) {
      pushLivePoint(state.quotes.get(state.selected));
    }

    renderOverview();
    renderTicker();
    renderRows();
    renderDetail();
    drawChart();

    el.serverTime.textContent = `更新于 ${hhmmss(state.serverTime)}`;

    if (firstLoad) {
      el.connText.textContent = "实时连接";
    }
  }

  function pushLivePoint(quote) {
    if (!quote) return;
    const ts = quote.time || Date.now();
    const last = state.history[state.history.length - 1];
    if (!last) {
      state.history.push([ts, quote.price]);
      return;
    }
    if (ts - last[0] >= 60000) {
      state.history.push([ts, quote.price]);
      if (state.history.length > MAX_POINTS) {
        state.history.splice(0, state.history.length - MAX_POINTS);
      }
    } else {
      state.history[state.history.length - 1] = [last[0], quote.price];
    }
  }

  async function select(symbol) {
    if (!symbol) return;
    state.selected = symbol;
    state.history = [];
    renderRows();
    renderDetail();
    drawChart();

    try {
      const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (state.selected !== symbol) return; // 切换过快，丢弃过期响应
      state.history = (data.points || []).map((p) => [p.t, p.p]);
      drawChart();
    } catch (err) {
      /* 网络异常时保留已有走势 */
    }
  }

  // ---------------------------------------------------------------- 渲染

  function renderOverview() {
    const quotes = state.order.map((s) => state.quotes.get(s)).filter(Boolean);
    let cards = quotes.filter((q) => q.market === "指数").slice(0, 4);
    if (cards.length < 4) {
      const extra = quotes.filter((q) => q.market !== "指数");
      cards = cards.concat(extra).slice(0, 4);
    }
    el.overview.innerHTML = cards
      .map(
        (q, i) => `
      <article class="card" style="animation-delay:${i * 40}ms">
        <div class="card-top">
          <span class="card-name">${escapeHtml(q.name)}</span>
          <span class="card-code">${escapeHtml(q.symbol)}</span>
        </div>
        <div class="card-price ${dirClass(q.changePct)}">${fmtPrice(q)}</div>
        <div class="card-meta">
          <span class="${dirClass(q.changePct)}">${signed(q.changePct)}%</span>
          <span class="abs">${signed(q.change, q.decimals)}</span>
        </div>
        <div class="card-spark">${sparkSvg(q, 108, 52)}</div>
      </article>`
      )
      .join("");
  }

  function tickerItemHtml(q) {
    return `<span class="tick-item" data-symbol="${escapeHtml(q.symbol)}">
      <span class="tn">${escapeHtml(q.name)}</span>
      <span class="tv">${fmtPrice(q)}</span>
      <span class="tp ${dirClass(q.changePct)}">${signed(q.changePct)}%</span>
    </span>`;
  }

  function renderTicker() {
    const track = el.tickerTrack;
    const key = state.order.join("|");
    if (track.dataset.key !== key) {
      const items = state.order
        .map((s) => state.quotes.get(s))
        .filter(Boolean)
        .map(tickerItemHtml)
        .join("");
      track.innerHTML = `<div class="ticker-group">${items}</div><div class="ticker-group" aria-hidden="true">${items}</div>`;
      track.dataset.key = key;
    }

    track.querySelectorAll(".tick-item").forEach((node) => {
      const q = state.quotes.get(node.dataset.symbol);
      if (!q) return;
      node.querySelector(".tv").textContent = fmtPrice(q);
      const pct = node.querySelector(".tp");
      pct.textContent = `${signed(q.changePct)}%`;
      pct.className = `tp ${dirClass(q.changePct)}`;
    });
  }

  function visibleQuotes() {
    let list = state.order.map((s) => state.quotes.get(s)).filter(Boolean);

    if (state.filter !== "全部") {
      list = list.filter((q) => q.market === state.filter);
    }

    const kw = state.query.trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (q) => q.symbol.toLowerCase().includes(kw) || q.name.toLowerCase().includes(kw)
      );
    }

    const dir = state.sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => ((a[state.sortKey] || 0) - (b[state.sortKey] || 0)) * dir);
    return list;
  }

  function renderRows() {
    const list = visibleQuotes();
    el.watchSub.textContent = `${list.length} / ${state.order.length} 个标的`;

    if (!list.length) {
      el.rows.innerHTML = '<tr><td colspan="5" class="empty">没有匹配的标的</td></tr>';
      return;
    }

    el.rows.innerHTML = list
      .map((q) => {
        const dir = dirClass(q.changePct);
        const active = state.selected === q.symbol ? "active" : "";
        return `<tr data-symbol="${escapeHtml(q.symbol)}" class="${active}">
          <td class="col-name">
            <div class="name">${escapeHtml(q.name)}</div>
            <div class="code">${escapeHtml(q.symbol)} · ${escapeHtml(q.market)}</div>
          </td>
          <td class="num price ${dir}">${fmtPrice(q)}</td>
          <td class="num"><span class="chg ${dir}">${signed(q.changePct)}%</span></td>
          <td class="num spark">${sparkSvg(q)}</td>
          <td class="num vol">${fmtVolume(q.volume)}</td>
        </tr>`;
      })
      .join("");
  }

  function renderDetail() {
    const q = state.quotes.get(state.selected);
    if (!q) {
      el.detailName.textContent = "--";
      el.detailMeta.textContent = "--";
      el.detailPrice.textContent = "--";
      el.detailPrice.className = "";
      el.detailChange.textContent = "--";
      el.detailChange.className = "pill";
      el.stats.innerHTML = "";
      return;
    }

    const dir = dirClass(q.changePct);
    el.detailName.textContent = q.name;
    el.detailMeta.textContent = `${q.symbol} · ${q.market} · ${q.currency}`;
    el.detailPrice.textContent = fmtPrice(q);
    el.detailPrice.className = dir;
    el.detailChange.textContent = `${signed(q.change, q.decimals)}  ${signed(q.changePct)}%`;
    el.detailChange.className = `pill ${dir}`;

    const amplitude = q.prevClose ? ((q.high - q.low) / q.prevClose) * 100 : 0;
    const stats = [
      ["今开", fmt(q.open, q.decimals)],
      ["昨收", fmt(q.prevClose, q.decimals)],
      ["最高", fmt(q.high, q.decimals)],
      ["最低", fmt(q.low, q.decimals)],
      ["成交量", fmtVolume(q.volume)],
      ["振幅", `${amplitude.toFixed(2)}%`],
    ];
    el.stats.innerHTML = stats
      .map(([label, value]) => `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
  }

  // ---------------------------------------------------------------- 分时图

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawChart() {
    const canvas = el.chart;
    const host = canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // clientWidth/clientHeight 是内容区尺寸（不含边框），且 canvas 使用绝对定位，
    // 不会参与父容器布局，避免"设高 → 容器变高 → 再设高"的循环放大。
    const W = Math.max(160, Math.floor(host.clientWidth));
    const H = Math.max(140, Math.floor(host.clientHeight));
    const pixelW = Math.round(W * dpr);
    const pixelH = Math.round(H * dpr);

    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const q = state.quotes.get(state.selected);
    const pts = state.history;
    const ready = !!(q && pts.length >= 2);
    el.chartHint.classList.toggle("hidden", ready);
    if (!ready) return;

    const padL = 14;
    const padR = 68;
    const padT = 16;
    const padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    let min = Infinity;
    let max = -Infinity;
    for (const [, p] of pts) {
      if (p < min) min = p;
      if (p > max) max = p;
    }
    const prevClose = q.prevClose;
    if (Number.isFinite(prevClose)) {
      min = Math.min(min, prevClose);
      max = Math.max(max, prevClose);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (max - min < 1e-9) {
      const bump = Math.max(Math.abs(max) * 0.002, 0.01);
      min -= bump;
      max += bump;
    }
    const padding = (max - min) * 0.12;
    min -= padding;
    max += padding;

    const t0 = pts[0][0];
    const t1 = pts[pts.length - 1][0];
    const spanT = Math.max(1, t1 - t0);
    const xOf = (t) => padL + ((t - t0) / spanT) * plotW;
    const yOf = (p) => padT + (1 - (p - min) / (max - min)) * plotH;

    ctx.font = '10px "Cascadia Code", Consolas, monospace';
    ctx.textBaseline = "middle";

    // 横向网格 + 右侧价格刻度
    const gridRows = 4;
    for (let i = 0; i <= gridRows; i += 1) {
      const gy = padT + (plotH / gridRows) * i;
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(W - padR, gy);
      ctx.stroke();

      const price = max - ((max - min) / gridRows) * i;
      ctx.fillStyle = "#6b7789";
      ctx.textAlign = "left";
      ctx.fillText(fmt(price, q.decimals), W - padR + 8, gy);
    }

    // 昨收参考线
    if (Number.isFinite(prevClose) && prevClose >= min && prevClose <= max) {
      const py = yOf(prevClose);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(154,165,184,0.32)";
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(W - padR, py);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "rgba(154,165,184,0.6)";
      ctx.textAlign = "left";
      ctx.fillText("昨收", W - padR + 8, py - 10);
    }

    const rising = q.changePct >= 0;
    const stroke = rising ? "#ff5b6a" : "#22c98b";

    // 面积渐变
    const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    gradient.addColorStop(0, rising ? "rgba(255,91,106,0.24)" : "rgba(34,201,139,0.24)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath();
    ctx.moveTo(xOf(pts[0][0]), yOf(pts[0][1]));
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(xOf(pts[i][0]), yOf(pts[i][1]));
    ctx.lineTo(xOf(t1), padT + plotH);
    ctx.lineTo(xOf(t0), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 走势线
    ctx.beginPath();
    ctx.moveTo(xOf(pts[0][0]), yOf(pts[0][1]));
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(xOf(pts[i][0]), yOf(pts[i][1]));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // 最新点
    const lastPrice = pts[pts.length - 1][1];
    const lx = xOf(t1);
    const ly = yOf(lastPrice);
    ctx.beginPath();
    ctx.arc(lx, ly, 7, 0, Math.PI * 2);
    ctx.fillStyle = rising ? "rgba(255,91,106,0.18)" : "rgba(34,201,139,0.18)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();

    // 右侧最新价气泡
    const label = fmt(lastPrice, q.decimals);
    ctx.font = '11px "Cascadia Code", Consolas, monospace';
    const textW = ctx.measureText(label).width;
    const boxW = textW + 12;
    const boxH = 19;
    let boxX = W - padR + 2;
    let boxY = ly - boxH / 2;
    boxX = Math.min(boxX, W - boxW - 2);
    boxY = Math.min(Math.max(boxY, padT), padT + plotH - boxH);
    roundRect(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.fillStyle = stroke;
    ctx.fill();
    ctx.fillStyle = "#0a0f18";
    ctx.textAlign = "left";
    ctx.fillText(label, boxX + 6, boxY + boxH / 2 + 0.5);

    // 时间轴
    ctx.fillStyle = "#5f6b7f";
    ctx.font = '10px "Cascadia Code", Consolas, monospace';
    ctx.textAlign = "left";
    ctx.fillText(hhmm(t0), padL, H - 8);
    ctx.textAlign = "right";
    ctx.fillText(hhmm(t1), W - padR, H - 8);
  }

  // ---------------------------------------------------------------- 交互

  function setConn(mode) {
    const dot = el.connDot;
    dot.classList.toggle("live", mode === "live");
    dot.classList.toggle("off", mode === "off");
    el.connText.textContent =
      mode === "live" ? "实时连接" : mode === "off" ? "重连中…" : "连接中…";
  }

  function connectStream() {
    const source = new EventSource("/api/stream");
    source.addEventListener("open", () => setConn("live"));
    source.addEventListener("quotes", (event) => {
      setConn("live");
      try {
        applyPayload(JSON.parse(event.data));
      } catch (err) {
        /* 忽略坏帧 */
      }
    });
    source.addEventListener("error", () => setConn("off"));
  }

  async function bootstrap() {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      if (res.ok) applyPayload(await res.json());
    } catch (err) {
      /* SSE 会兜底 */
    }
    connectStream();
  }

  function updateClock() {
    el.clock.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  function buildFilters() {
    el.filters.innerHTML = MARKETS.map(
      (m) =>
        `<button type="button" class="chip${m === state.filter ? " active" : ""}" data-market="${m}">${m}</button>`
    ).join("");
  }

  function updateSortIndicators() {
    document.querySelectorAll("th.sortable").forEach((th) => {
      const active = th.dataset.sort === state.sortKey;
      th.classList.toggle("sorted-asc", active && state.sortDir === "asc");
      th.classList.toggle("sorted-desc", active && state.sortDir === "desc");
    });
  }

  function bindEvents() {
    el.search.addEventListener("input", (event) => {
      state.query = event.target.value;
      renderRows();
    });

    el.filters.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.dataset.market || "全部";
      el.filters.querySelectorAll(".chip").forEach((item) => {
        item.classList.toggle("active", item === chip);
      });
      renderRows();
    });

    document.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
        } else {
          state.sortKey = key;
          state.sortDir = "desc";
        }
        updateSortIndicators();
        renderRows();
      });
    });

    el.rows.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-symbol]");
      if (row) select(row.dataset.symbol);
    });

    if (typeof ResizeObserver === "function") {
      let pending = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(drawChart);
      });
      observer.observe(el.chart.parentElement);
    } else {
      window.addEventListener("resize", drawChart);
    }
  }

  function init() {
    el.tickerTrack = $_("tickerTrack");
    el.connDot = $_("connDot");
    el.connText = $_("connText");
    el.clock = $_("clock");
    el.overview = $_("overview");
    el.rows = $_("rows");
    el.search = $_("search");
    el.filters = $_("filters");
    el.watchSub = $_("watchSub");
    el.detailName = $_("detailName");
    el.detailMeta = $_("detailMeta");
    el.detailPrice = $_("detailPrice");
    el.detailChange = $_("detailChange");
    el.chart = $_("chart");
    el.chartHint = $_("chartHint");
    el.stats = $_("stats");
    el.serverTime = $_("serverTime");

    buildFilters();
    updateSortIndicators();
    bindEvents();
    updateClock();
    setInterval(updateClock, 1000);
    bootstrap();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
