const state = {
  hosts: [],
  events: [],
  filter: "all",
  sort: "ip",
  sortDirection: 1,
  selectedIp: null,
  lastScan: null,
  scanIntervalSeconds: 60
};

const test={
  return "OK";
}

const elements = Object.fromEntries([
  "connection-label", "last-scan", "next-scan", "system-banner", "system-status", "system-note",
  "total-count", "online-count", "offline-count", "latency-count", "host-total", "host-search",
  "host-rows", "filter-all-count", "filter-online-count", "filter-offline-count", "table-result-count",
  "event-list", "sort-button", "scan-button", "add-host-button", "host-dialog", "host-form",
  "host-form-error", "detail-dialog", "detail-ip", "detail-name", "detail-type", "detail-status",
  "detail-latency", "detail-last-check", "detail-tcp", "latency-chart", "chart-empty", "edit-host-button"
].map(id => [id, document.getElementById(id)]));

const signalRClient = window.signalR;
let scanIntervalId;

function formatTime(value) {
  if (!value || value === "0001-01-01T00:00:00") return "Never";
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(normalized));
}

function hostState(host) {
  if (!host.lastChecked || new Date(host.lastChecked).getFullYear() < 2000) return "unknown";
  if (host.online && host.tcpStatus?.includes("TIMEOUT")) return "warning";
  return host.online ? "online" : "offline";
}

function renderSummary(summary, hosts) {
  elements["total-count"].textContent = summary.total;
  elements["online-count"].textContent = summary.online;
  elements["offline-count"].textContent = summary.offline;
  elements["latency-count"].textContent = Math.round(summary.averageLatency);
  elements["host-total"].textContent = summary.total;
  elements["filter-all-count"].textContent = summary.total;
  elements["filter-online-count"].textContent = summary.online;
  elements["filter-offline-count"].textContent = summary.offline;

  const banner = elements["system-banner"];
  const warningCount = hosts.filter(host => hostState(host) === "warning").length;
  const status = summary.total === 0 ? "unknown" : summary.offline > 0 || warningCount > 0 ? "warning" : "healthy";
  banner.dataset.state = status === "healthy" ? "healthy" : status === "warning" ? "warning" : "unknown";
  elements["system-status"].textContent = status === "healthy" ? "HEALTHY" : status === "warning" ? "ATTENTION" : "DISCOVERING";
  elements["system-note"].textContent = status === "healthy"
    ? "All monitored hosts are responding"
    : status === "warning" ? `${summary.offline} offline · ${warningCount} with TCP timeouts` : "Waiting for the first network scan";
}

function filteredHosts() {
  const query = elements["host-search"].value.trim().toLowerCase();
  return state.hosts.filter(host => {
    const status = hostState(host);
    const matchesFilter = state.filter === "all" || status === state.filter;
    const matchesSearch = !query || [host.ipAddress, host.displayName, host.deviceType].some(value => value?.toLowerCase().includes(query));
    return matchesFilter && matchesSearch;
  }).sort((a, b) => {
    let comparison = 0;
    if (state.sort === "ip") {
      const ipA = a.ipAddress.split(".").map(Number);
      const ipB = b.ipAddress.split(".").map(Number);
      comparison = ipA.findIndex((octet, index) => octet !== ipB[index]);
      if (comparison < 0) return 0;
      comparison = ipA[comparison] - ipB[comparison];
    } else if (state.sort === "latency") comparison = a.latencyMs - b.latencyMs;
    else if (state.sort === "status") comparison = hostState(a).localeCompare(hostState(b));
    else comparison = new Date(a.lastChecked) - new Date(b.lastChecked);
    return comparison * state.sortDirection;
  });
}

function renderHosts() {
  const hosts = filteredHosts();
  elements["table-result-count"].textContent = `${hosts.length} device${hosts.length === 1 ? "" : "s"}`;
  if (!hosts.length) {
    const filtered = state.hosts.length > 0;
    elements["host-rows"].innerHTML = `<tr class="empty-row"><td colspan="7"><span class="empty-mark">${filtered ? "⌕" : "◌"}</span><strong>${filtered ? "No matching hosts" : "Discovering network devices"}</strong><small>${filtered ? "Try a different search or filter." : "Hosts that respond to the first scan will appear here."}</small></td></tr>`;
    return;
  }

  elements["host-rows"].innerHTML = hosts.map(host => {
    const status = hostState(host);
    const label = status === "unknown" ? "UNKNOWN" : status.toUpperCase();
    const tcp = host.tcpStatus || "Not checked";
    const latency = status === "online" || status === "warning" ? `${host.latencyMs} ms` : "—";
    return `<tr data-ip="${escapeHtml(host.ipAddress)}"><td class="ip-cell">${escapeHtml(host.ipAddress)}</td><td class="name-cell">${escapeHtml(host.displayName || "—")}</td><td class="type-cell">${escapeHtml(host.deviceType || "Unknown")}</td><td><span class="status-pill ${status}">${label}</span></td><td class="latency-cell">${latency}</td><td class="tcp-cell" title="${escapeHtml(tcp)}">${escapeHtml(tcp)}</td><td class="time-cell">${formatTime(host.lastChecked)}</td></tr>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function renderEvents() {
  if (!state.events.length) {
    elements["event-list"].innerHTML = '<li class="event-empty">No status changes recorded yet.</li>';
    return;
  }
  elements["event-list"].innerHTML = state.events.slice(0, 12).map(event => {
    const offline = event.message.toLowerCase().includes("offline");
    return `<li class="${offline ? "event-offline" : ""}"><time>${formatTime(event.timestamp)}</time><p>${escapeHtml(event.message)}</p></li>`;
  }).join("");
}

function applyUpdate(hosts, summary, timestamp) {
  state.hosts = hosts;
  state.lastScan = timestamp;
  elements["last-scan"].textContent = formatTime(timestamp);
  renderSummary(summary, hosts);
  renderHosts();
  if (state.selectedIp) {
    const current = hosts.find(host => host.ipAddress === state.selectedIp);
    if (current && elements["detail-dialog"].open) renderHostDetail(current);
  }
  scheduleNextScan();
}

function scheduleNextScan() {
  clearInterval(scanIntervalId);
  const nextTime = Date.now() + state.scanIntervalSeconds * 1000;
  const update = () => {
    const now = Date.now();
    if (now >= nextTime) {
      elements["next-scan"].textContent = "Scanning...";
    } else {
      elements["next-scan"].textContent = new Date().toLocaleTimeString([], { hour12: false });
    }
  };
  update();
  scanIntervalId = setInterval(update, 1000);
}

async function loadInitialData() {
  const [hostsResponse, eventsResponse, configResponse] = await Promise.all([
    fetch("/api/network/hosts"), fetch("/api/network/events"), fetch("/api/network/config")
  ]);
  if (!hostsResponse.ok || !eventsResponse.ok || !configResponse.ok) throw new Error("Could not load network status.");
  const hosts = await hostsResponse.json();
  state.events = await eventsResponse.json();
  const config = await configResponse.json();
  state.scanIntervalSeconds = config.scanIntervalSeconds;
  document.getElementById("network-label").textContent = config.network;
  document.getElementById("footer-range").textContent = `${config.startIp} — ${config.endIp}`;
  applyUpdate(hosts, summarize(hosts), hosts.reduce((latest, host) => host.lastChecked > latest ? host.lastChecked : latest, ""));
  renderEvents();
}

function summarize(hosts) {
  const online = hosts.filter(host => host.online);
  return { total: hosts.length, online: online.length, offline: hosts.length - online.length,
    averageLatency: online.length ? online.reduce((total, host) => total + host.latencyMs, 0) / online.length : 0 };
}

async function connectSignalR() {
  if (!signalRClient) {
    setConnection(false);
    return;
  }
  const connection = new signalRClient.HubConnectionBuilder().withUrl("/monitorHub").withAutomaticReconnect().build();
  connection.on("networkUpdate", update => applyUpdate(update.hosts, update.summary, update.timestamp));
  connection.on("hostStatusChanged", event => {
    state.events.unshift({ ipAddress: event.ipAddress, message: `${event.displayName || event.ipAddress} went ${event.currentStatus}.`, timestamp: event.timestamp });
    renderEvents();
  });
  connection.onreconnecting(() => setConnection(false));
  connection.onreconnected(() => setConnection(true));
  connection.onclose(() => setConnection(false));
  try {
    await connection.start();
    setConnection(true);
  } catch {
    setConnection(false);
    setTimeout(connectSignalR, 5000);
  }
}

function setConnection(connected) {
  const indicator = document.querySelector(".live-indicator");
  indicator.dataset.state = connected ? "connected" : "disconnected";
  elements["connection-label"].textContent = connected ? "LIVE" : "RECONNECTING";
}

async function loadHostDetail(ipAddress) {
  state.selectedIp = ipAddress;
  const [hostResponse, historyResponse] = await Promise.all([
    fetch(`/api/network/hosts/${encodeURIComponent(ipAddress)}`),
    fetch(`/api/network/history/${encodeURIComponent(ipAddress)}`)
  ]);
  if (!hostResponse.ok) return;
  const host = await hostResponse.json();
  renderHostDetail(host);
  if (historyResponse.ok) drawLatency(await historyResponse.json());
  elements["detail-dialog"].showModal();
}

function renderHostDetail(host) {
  elements["detail-ip"].textContent = host.ipAddress;
  elements["detail-name"].textContent = host.displayName || "Unnamed device";
  elements["detail-type"].textContent = host.deviceType || "Unknown";
  const status = hostState(host);
  elements["detail-status"].textContent = status === "unknown" ? "UNKNOWN" : status.toUpperCase();
  elements["detail-status"].style.color = status === "online" ? "var(--green)" : status === "offline" ? "var(--red)" : "var(--amber)";
  elements["detail-latency"].textContent = host.online ? `${host.latencyMs} ms` : "—";
  elements["detail-last-check"].textContent = formatTime(host.lastChecked);
  const ports = (host.tcpStatus || "").split(", ").filter(Boolean);
  elements["detail-tcp"].innerHTML = ports.length
    ? ports.map(value => `<li class="${value.includes("OPEN") ? "open" : value.includes("TIMEOUT") ? "timeout" : ""}">${escapeHtml(value)}</li>`).join("")
    : '<li>No check recorded</li>';
  elements["edit-host-button"].dataset.ip = host.ipAddress;
}

function drawLatency(history) {
  const canvas = elements["latency-chart"];
  const context = canvas.getContext("2d");
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = bounds.width * ratio;
  canvas.height = bounds.height * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const samples = history.filter(point => point.online);
  elements["chart-empty"].hidden = samples.length > 1;
  if (samples.length < 2) return;
  const padding = { x: 9, y: 12 };
  const max = Math.max(10, ...samples.map(point => point.latencyMs));
  const points = samples.map((sample, index) => ({
    x: padding.x + index * ((bounds.width - padding.x * 2) / (samples.length - 1)),
    y: bounds.height - padding.y - (sample.latencyMs / max) * (bounds.height - padding.y * 2)
  }));
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.strokeStyle = "#9be2a9";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#9be2a9";
  for (const point of points) {
    context.beginPath();
    context.arc(point.x, point.y, 2, 0, Math.PI * 2);
    context.fill();
  }
}

async function submitHost(event) {
  event.preventDefault();
  const form = new FormData(elements["host-form"]);
  const body = Object.fromEntries(form.entries());
  elements["host-form-error"].textContent = "";
  const response = await fetch("/api/network/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    elements["host-form-error"].textContent = error.error || "Could not add this host.";
    return;
  }
  elements["host-dialog"].close();
  elements["host-form"].reset();
  await loadInitialData();
  await fetch("/api/network/scan", { method: "POST" });
}

async function editHost() {
  const host = state.hosts.find(item => item.ipAddress === elements["edit-host-button"].dataset.ip);
  if (!host) return;
  const name = prompt("Device name", host.displayName || "");
  if (name === null) return;
  const deviceType = prompt("Device type", host.deviceType || "Unknown");
  if (deviceType === null) return;
  const response = await fetch(`/api/network/hosts/${encodeURIComponent(host.ipAddress)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: name, deviceType, enabled: true })
  });
  if (response.ok) await loadInitialData();
}

elements["host-search"].addEventListener("input", renderHosts);
document.querySelectorAll(".filter-tab").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".filter-tab").forEach(tab => tab.classList.toggle("active", tab === button));
  state.filter = button.dataset.filter;
  renderHosts();
}));
elements["sort-button"].addEventListener("click", () => {
  const sorts = ["ip", "latency", "status", "time"];
  const current = sorts.indexOf(state.sort);
  state.sort = sorts[(current + 1) % sorts.length];
  state.sortDirection = state.sort === "ip" ? 1 : -1;
  const names = { ip: "IP ADDRESS", latency: "LATENCY", status: "STATUS", time: "LAST CHECK" };
  elements["sort-button"].textContent = `${names[state.sort]} ${state.sortDirection > 0 ? "↑" : "↓"}`;
  renderHosts();
});
elements["host-rows"].addEventListener("click", event => {
  const row = event.target.closest("tr[data-ip]");
  if (row) loadHostDetail(row.dataset.ip);
});
elements["add-host-button"].addEventListener("click", () => elements["host-dialog"].showModal());
elements["host-form"].addEventListener("submit", submitHost);
elements["edit-host-button"].addEventListener("click", editHost);
elements["scan-button"].addEventListener("click", async () => {
  const response = await fetch("/api/network/scan", { method: "POST" });
  elements["system-note"].textContent = response.ok ? "Manual scan queued" : "A scan is already running or rate limited";
});
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    elements["host-search"].focus();
  }
});
elements["detail-dialog"].addEventListener("close", () => { state.selectedIp = null; });

loadInitialData().catch(error => {
  elements["system-status"].textContent = "UNAVAILABLE";
  elements["system-note"].textContent = error.message;
});
connectSignalR();