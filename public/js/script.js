const form = document.getElementById("videoForm");

const downloadBtn = document.getElementById("downloadBtn");
const mp3Btn = document.getElementById("mp3Btn");
const thumbBtn = document.getElementById("thumbBtn");

const qualitySelect = document.getElementById("qualitySelect");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const progressMeta = document.getElementById("progressMeta");

let lastRenderedPct = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function clearResult() {
  resultEl.innerHTML = "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getUrlFromForm() {
  const formData = new FormData(form);
  return String(formData.get("videoUrl") || "").trim();
}

function setButtonsDisabled(disabled) {
  downloadBtn.disabled = disabled;
  mp3Btn.disabled = disabled;
  thumbBtn.disabled = disabled;
  qualitySelect.disabled = disabled;
}

function showProgress() {
  if (progressWrap) progressWrap.style.display = "block";
}

function hideProgress() {
  if (progressWrap) progressWrap.style.display = "none";
}

function setProgress(pct, meta = "") {
  if (!progressBar || !progressText || !progressMeta) return;

  const p = Math.max(0, Math.min(100, Number(pct) || 0));

  if (
    lastRenderedPct !== null &&
    Math.abs(lastRenderedPct - p) < 0.01 &&
    progressMeta.textContent === meta
  ) {
    return;
  }
  lastRenderedPct = p;

  progressBar.style.width = `${p}%`;
  progressText.textContent = `${p.toFixed(1)}%`;
  progressMeta.textContent = meta;
}

async function createJob(payload) {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`createJob failed: ${res.status} ${txt}`);
  }
  return res.json();
}

async function getJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(`getJob failed: ${res.status}`);
  return res.json();
}

function renderResult({ kind, file }) {
  const url = `/api/download/${encodeURIComponent(file)}`;

  const a = document.createElement("a");
  a.href = url;
  a.className = "btn btn-download";
  a.setAttribute("download", file);

  a.textContent =
    kind === "thumb"
      ? "Скачать превью"
      : kind === "mp3"
      ? "Скачать MP3"
      : "Скачать файл";

  const arrow = document.createElement("span");
  arrow.textContent = "⬇";
  arrow.style.fontSize = "16px";
  a.appendChild(arrow);

  resultEl.appendChild(a);

  if (kind === "thumb") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "preview";
    img.style.display = "block";
    img.style.maxWidth = "320px";
    img.style.margin = "12px auto 0";
    img.style.border = "2px solid #000";
    resultEl.appendChild(img);
  }

  resultEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

function normalizeProgress(progress) {
  if (progress == null) return null;

  let p = progress;

  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      return null;
    }
  }

  if (typeof p === "number") {
    return { pct: p, phase: "", speed: null, eta: null };
  }

  if (typeof p === "object") {
    return {
      pct: p.pct ?? p.percent ?? 0,
      phase: p.phase ?? "",
      speed: p.speed ?? null,
      eta: p.eta ?? null,
    };
  }

  return null;
}

function applyProgress(job) {
  const pr = normalizeProgress(job?.progress);
  if (!pr) return;

  const phaseMap = {
    download: "скачивание",
    merge: "склейка",
    convert: "конвертация",
    done: "готово",
  };
  const phase = phaseMap[pr.phase] || pr.phase || "";

  const speed = pr.speed ? `скорость: ${pr.speed}` : "";
  const eta = pr.eta ? `ETA: ${pr.eta}` : "";

  const meta = [phase, speed, eta].filter(Boolean).join(" • ");
  setProgress(pr.pct, meta);
}

async function runFlow({ kind, quality }) {
  clearResult();

  const url = getUrlFromForm();
  if (!url) {
    setStatus("Введите ссылку.");
    return;
  }

  try {
    setButtonsDisabled(true);

    lastRenderedPct = null;
    showProgress();
    setProgress(0, "");

    setStatus("Создаю задачу...");

    const payload = { url, kind };
    if (quality) payload.quality = quality;

    const { jobId } = await createJob(payload);
    setStatus(`В очереди (jobId: ${jobId})...`);

    while (true) {
      const job = await getJob(jobId);

      applyProgress(job);

      if (job.status === "completed") {
        setStatus("Готово.");
        setProgress(100, "готово");
        renderResult({ kind, file: job.file });
        break;
      }

      if (job.status === "failed") {
        setStatus("Ошибка при скачивании.");
        hideProgress();
        resultEl.textContent = job.error || "Unknown error";
        break;
      }

      setStatus(`Статус: ${job.status}...`);
      await sleep(900);
    }
  } catch (e) {
    setStatus("Ошибка запроса к серверу.");
    hideProgress();
    resultEl.textContent = String(e?.message || e);
  } finally {
    setButtonsDisabled(false);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runFlow({ kind: "video", quality: qualitySelect.value || "best" });
});

mp3Btn.addEventListener("click", () => {
  runFlow({ kind: "mp3" });
});

thumbBtn.addEventListener("click", () => {
  runFlow({ kind: "thumb" });
});
