const API_URL = "/api/readers";
const SUBJECTS = ["English", "Chinese", "Math"];

const fallbackState = {
  currentReaderId: null,
  readers: [],
};

const form = document.querySelector("#reader-form");
const resetButton = document.querySelector("#reset-button");
const leaderboardList = document.querySelector("#leaderboard-list");
const readerRank = document.querySelector("#reader-rank");
const progressDate = document.querySelector("#progress-date");
const goalsModal = document.querySelector("#goals-modal");
const goalsModalForm = document.querySelector("#goals-modal-form");
const closeGoalsModalButton = document.querySelector("#close-goals-modal");
const cancelGoalsUpdateButton = document.querySelector("#cancel-goals-update");
const goalsModalMessage = document.querySelector("#goals-modal-message");
const timerReaderName = document.querySelector("#timer-reader-name");
const timerDisplay = document.querySelector("#timer-display");
const timerStatus = document.querySelector("#timer-status");
const startTimerButton = document.querySelector("#start-timer-button");
const stopTimerButton = document.querySelector("#stop-timer-button");
const subjectModal = document.querySelector("#subject-modal");
const closeSubjectModalButton = document.querySelector("#close-subject-modal");

const fields = {
  name: document.querySelector("#reader-name"),
  subjectGoals: Object.fromEntries(
    SUBJECTS.map((subject) => [
      subject,
      {
        workday: document.querySelector(`#${subject.toLowerCase()}-workday-goal`),
        weekend: document.querySelector(`#${subject.toLowerCase()}-weekend-goal`),
      },
    ]),
  ),
};

const goalsModalFields = {
  name: document.querySelector("#goals-reader-name"),
  subjectGoals: Object.fromEntries(
    SUBJECTS.map((subject) => [
      subject,
      {
        workday: document.querySelector(`#modal-${subject.toLowerCase()}-workday-goal`),
        weekend: document.querySelector(`#modal-${subject.toLowerCase()}-weekend-goal`),
      },
    ]),
  ),
};

const progress = {
  dailyText: document.querySelector("#daily-progress-text"),
  weeklyText: document.querySelector("#weekly-progress-text"),
  dailyMeter: document.querySelector("#daily-meter"),
  weeklyMeter: document.querySelector("#weekly-meter"),
};

const subjectProgress = {
  daily: {
    English: document.querySelector("#daily-english-time-text"),
    Chinese: document.querySelector("#daily-chinese-time-text"),
    Math: document.querySelector("#daily-math-time-text"),
  },
  weekly: {
    English: document.querySelector("#weekly-english-time-text"),
    Chinese: document.querySelector("#weekly-chinese-time-text"),
    Math: document.querySelector("#weekly-math-time-text"),
  },
};

let state = structuredClone(fallbackState);
let timerStartedAt = null;
let timerInterval = null;
let timerSavedMinutes = 0;
let timerSaving = false;
let timerActiveReaderName = "";
let timerActiveSubject = "";
let selectedDateKey = getLocalDateKey();

function isServerSideBrowser() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDailyRecord(reader, dateKey = selectedDateKey) {
  return reader?.dailyRecords?.[dateKey] ?? null;
}

function hasDateRecords(reader) {
  return !!reader?.dailyRecords && Object.keys(reader.dailyRecords).length > 0;
}

function isWeekend(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  const day = date.getDay();
  return day === 0 || day === 6;
}

function getIsoWeekParts(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + 4 - (date.getDay() || 7));
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { year: date.getFullYear(), week };
}

function isSameIsoWeek(dateKey, targetDateKey) {
  const dateParts = getIsoWeekParts(dateKey);
  const targetParts = getIsoWeekParts(targetDateKey);
  return dateParts.year === targetParts.year && dateParts.week === targetParts.week;
}

function scoreReader(reader, dateKey = selectedDateKey) {
  const values = getProgressValues(reader, dateKey);
  return values.weekly;
}

function getRankedReaders() {
  return [...state.readers].sort((a, b) => scoreReader(b) - scoreReader(a));
}

function getCurrentReader() {
  return state.readers.find((reader) => reader.id === state.currentReaderId) ?? null;
}

function clampPercent(value, goal) {
  if (!goal) return 0;
  return Math.min(100, Math.round((value / goal) * 100));
}

function readNumber(field, fallback) {
  const parsed = Number(field.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readSubjectGoals(source) {
  return Object.fromEntries(
    SUBJECTS.map((subject) => [
      subject,
      {
        workday: readNumber(source.subjectGoals[subject].workday, 20),
        weekend: readNumber(source.subjectGoals[subject].weekend, 30),
      },
    ]),
  );
}

function getSubjectGoals(reader) {
  const storedGoals = reader?.goals?.subjects ?? {};
  return Object.fromEntries(
    SUBJECTS.map((subject) => [
      subject,
      {
        workday: storedGoals[subject]?.workday ?? storedGoals[subject]?.daily ?? 20,
        weekend: storedGoals[subject]?.weekend ?? storedGoals[subject]?.daily ?? 30,
      },
    ]),
  );
}

function getSubjectDailyGoal(reader, dateKey = selectedDateKey) {
  const goals = getSubjectGoals(reader);
  const goalType = isWeekend(dateKey) ? "weekend" : "workday";
  return SUBJECTS.reduce((total, subject) => total + goals[subject][goalType], 0);
}

function getSubjectWeeklyGoal(reader) {
  const goals = getSubjectGoals(reader);
  return SUBJECTS.reduce((total, subject) => {
    return total + goals[subject].workday * 5 + goals[subject].weekend * 2;
  }, 0);
}

function createReaderId() {
  if (globalThis.crypto?.randomUUID) {
    return `reader-${globalThis.crypto.randomUUID()}`;
  }

  const randomValue = Math.random().toString(36).slice(2, 10);
  return `reader-${Date.now().toString(36)}-${randomValue}`;
}

function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function getErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function setTimerRunning(isRunning) {
  startTimerButton.disabled = isRunning || !state.readers.length;
  stopTimerButton.disabled = !isRunning;
}

function updateTimerDisplay() {
  timerDisplay.textContent = timerStartedAt ? formatDuration(Date.now() - timerStartedAt) : "00:00:00";
}

function openSubjectModal() {
  subjectModal.hidden = false;
}

function closeSubjectModal() {
  subjectModal.hidden = true;
}

function startTimerForSubject(subject) {
  const name = timerReaderName.value.trim();
  if (!name) {
    timerReaderName.focus();
    return;
  }

  timerStartedAt = Date.now();
  timerSavedMinutes = 0;
  timerActiveReaderName = name;
  timerActiveSubject = subject;
  timerReaderName.disabled = true;
  setTimerRunning(true);
  closeSubjectModal();
  timerStatus.textContent = `${name} is studying ${subject}`;
  updateTimerDisplay();
  timerInterval = window.setInterval(() => {
    updateTimerDisplay();
    autosaveTimerProgress();
  }, 1000);
}

async function saveTimerMinutes(readerName, minutes, successMessage) {
  if (timerSaving || minutes <= 0) return false;

  timerSaving = true;
  try {
    const data = await addReadingSession(readerName, minutes, timerActiveSubject);
    state = {
      currentReaderId: data.currentReaderId,
      readers: data.readers,
    };
    render();
    timerStatus.textContent = successMessage;
    return true;
  } catch (error) {
    timerStatus.textContent = getErrorMessage(error, "Timer save failed");
    return false;
  } finally {
    timerSaving = false;
  }
}

async function autosaveTimerProgress() {
  if (!timerStartedAt) return;

  const name = timerActiveReaderName;
  const elapsedWholeMinutes = Math.floor((Date.now() - timerStartedAt) / 60000);
  const unsavedMinutes = elapsedWholeMinutes - timerSavedMinutes;
  if (!name || unsavedMinutes <= 0) return;

  const saved = await saveTimerMinutes(name, unsavedMinutes, `Saved ${elapsedWholeMinutes} min so far`);
  if (saved) {
    timerSavedMinutes += unsavedMinutes;
  }
}

async function waitForActiveTimerSave() {
  while (timerSaving) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
}

function getProgressValues(reader, dateKey = selectedDateKey) {
  const dailyRecord = getDailyRecord(reader, dateKey);
  const canUseLegacyTotals = !hasDateRecords(reader) && dateKey === getLocalDateKey();
  const subjectTotals = getSubjectTotals(reader, dateKey);
  const subjectDailyTotal = sumSubjectTotals(subjectTotals.daily);
  const subjectWeeklyTotal = sumSubjectTotals(subjectTotals.weekly);
  const legacyDailyTotal =
    dailyRecord?.todayMinutes ?? dailyRecord?.minutes ?? (canUseLegacyTotals ? reader?.todayMinutes ?? 0 : 0);
  const legacyWeeklyTotal = dailyRecord?.weekMinutes ?? (canUseLegacyTotals ? reader?.weekMinutes ?? 0 : 0);

  return {
    today: subjectDailyTotal || legacyDailyTotal,
    weekly: subjectWeeklyTotal || legacyWeeklyTotal,
    dailyGoal: getSubjectDailyGoal(reader, dateKey),
    weeklyGoal: getSubjectWeeklyGoal(reader),
  };
}

function createSubjectTotals() {
  return Object.fromEntries(SUBJECTS.map((subject) => [subject, 0]));
}

function sumSubjectTotals(totals) {
  return SUBJECTS.reduce((total, subject) => total + totals[subject], 0);
}

function getSubjectTotals(reader, dateKey = selectedDateKey) {
  const totals = {
    daily: createSubjectTotals(),
    weekly: createSubjectTotals(),
  };
  const sessions = Array.isArray(reader?.readingSessions) ? reader.readingSessions : [];

  sessions.forEach((session) => {
    if (!SUBJECTS.includes(session.subject)) return;
    if (!session.recordDate) return;

    const minutes = Number(session.minutes);
    if (!Number.isFinite(minutes)) return;

    if (session.recordDate === dateKey) {
      totals.daily[session.subject] += minutes;
    }

    if (isSameIsoWeek(session.recordDate, dateKey)) {
      totals.weekly[session.subject] += minutes;
    }
  });

  return totals;
}

function updateSubjectProgress(reader = getCurrentReader(), dateKey = selectedDateKey) {
  const totals = getSubjectTotals(reader, dateKey);
  const goals = getSubjectGoals(reader);
  SUBJECTS.forEach((subject) => {
    const dailyGoal = isWeekend(dateKey) ? goals[subject].weekend : goals[subject].workday;
    const weeklyGoal = goals[subject].workday * 5 + goals[subject].weekend * 2;
    subjectProgress.daily[subject].textContent = `${totals.daily[subject]} / ${dailyGoal} min`;
    subjectProgress.weekly[subject].textContent = `${totals.weekly[subject]} / ${weeklyGoal} min`;
  });
}

function updateProgress(reader = getCurrentReader(), dateKey = selectedDateKey) {
  const { today, weekly, dailyGoal, weeklyGoal } = getProgressValues(reader, dateKey);

  progress.dailyText.textContent = `${today} / ${dailyGoal} min`;
  progress.weeklyText.textContent = `${weekly} / ${weeklyGoal} min`;

  progress.dailyMeter.style.width = `${clampPercent(today, dailyGoal)}%`;
  progress.weeklyMeter.style.width = `${clampPercent(weekly, weeklyGoal)}%`;
}

function updateRankPill() {
  const ranked = getRankedReaders();
  const currentIndex = ranked.findIndex((reader) => reader.id === state.currentReaderId);
  readerRank.textContent = currentIndex >= 0 ? `Rank #${currentIndex + 1}` : `${ranked.length} readers`;
}

function previewReaderProgress(reader) {
  updateProgress(reader);
  updateSubjectProgress(reader);
  readerRank.textContent = reader ? `${reader.name}'s goals` : "Add a reader";
}

function restoreCurrentProgress() {
  updateProgress();
  updateSubjectProgress();
  updateRankPill();
}

function updateLeaderboard() {
  const ranked = getRankedReaders();
  leaderboardList.innerHTML = "";

  if (!ranked.length) {
    const emptyRow = document.createElement("li");
    emptyRow.className = "empty-row";
    emptyRow.textContent = "No readers yet";
    leaderboardList.append(emptyRow);
    readerRank.textContent = "Add a reader";
    return;
  }

  ranked.forEach((reader, index) => {
    const row = document.createElement("li");
    row.className = `leader-row${reader.id === state.currentReaderId ? " current-reader" : ""}`;
    row.dataset.readerId = reader.id;

    const place = document.createElement("span");
    place.className = "place";
    place.textContent = index + 1;

    const details = document.createElement("span");
    const name = document.createElement("span");
    name.className = "reader-name";
    name.textContent = reader.name;
    details.append(name);

    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `${scoreReader(reader)} pts`;

    const goalsButton = document.createElement("button");
    goalsButton.className = "goals-reader-button";
    goalsButton.type = "button";
    goalsButton.dataset.readerId = reader.id;
    goalsButton.setAttribute("aria-label", `Update reading goals for ${reader.name}`);
    goalsButton.title = `Update reading goals for ${reader.name}`;
    goalsButton.textContent = "Goals";

    const removeButton = document.createElement("button");
    removeButton.className = "remove-reader-button";
    removeButton.type = "button";
    removeButton.dataset.readerId = reader.id;
    removeButton.setAttribute("aria-label", `Delete ${reader.name}`);
    removeButton.title = `Delete ${reader.name}`;
    removeButton.textContent = "Delete";

    row.append(place, details, score, goalsButton, removeButton);
    leaderboardList.append(row);
  });

  updateRankPill();
}

function updateTimerReaderOptions() {
  const selectedName = timerReaderName.value;
  timerReaderName.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.readers.length ? "Choose a reader" : "No readers yet";
  timerReaderName.append(placeholder);

  state.readers.forEach((reader) => {
    const option = document.createElement("option");
    option.value = reader.name;
    option.textContent = reader.name;
    timerReaderName.append(option);
  });

  const selectedReader = state.readers.find((reader) => reader.name === selectedName);
  const currentReader = getCurrentReader();
  timerReaderName.value = selectedReader?.name ?? currentReader?.name ?? "";
  startTimerButton.disabled = !state.readers.length || !!timerStartedAt;
}

function render() {
  updateProgress();
  updateSubjectProgress();
  updateLeaderboard();
  updateTimerReaderOptions();
}

function clearReaderFields() {
  fields.name.value = "";
  fields.name.focus();
}

function openGoalsModal(reader) {
  state.currentReaderId = reader.id;
  render();

  goalsModalFields.name.value = reader.name;
  const subjectGoals = getSubjectGoals(reader);
  SUBJECTS.forEach((subject) => {
    goalsModalFields.subjectGoals[subject].workday.value = subjectGoals[subject].workday;
    goalsModalFields.subjectGoals[subject].weekend.value = subjectGoals[subject].weekend;
  });
  goalsModalMessage.textContent = "";
  goalsModal.hidden = false;
  goalsModalFields.subjectGoals.English.workday.focus();
}

function closeGoalsModal() {
  goalsModal.hidden = true;
  goalsModalMessage.textContent = "";
}

function configureServerOnlyControls() {
  resetButton.hidden = !isServerSideBrowser();
}

async function loadReaders() {
  const response = await fetch(API_URL);
  if (!response.ok) throw new Error("Unable to load readers");
  const data = await response.json();

  state = {
    currentReaderId: data.currentReaderId ?? null,
    readers: Array.isArray(data.readers) ? data.readers : [],
  };
  render();
}

async function addReader(reader) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reader),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? "Unable to save reader");
  }
  return response.json();
}

async function clearReaders() {
  const response = await fetch(API_URL, { method: "DELETE" });
  if (!response.ok) throw new Error("Unable to clear readers");
  return response.json();
}

async function updateGoals(readerName, goals) {
  const response = await fetch(`${API_URL}/${encodeURIComponent(readerName)}/goals`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goals }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? "Unable to update goals");
  }
  return response.json();
}

async function addReadingSession(readerName, minutes, subject) {
  const response = await fetch(`${API_URL}/${encodeURIComponent(readerName)}/reading-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes, recordDate: getLocalDateKey(), subject }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? "Unable to save reading time");
  }
  return response.json();
}

async function removeReader(readerId) {
  const response = await fetch(`${API_URL}/${encodeURIComponent(readerId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Unable to remove reader");
  return response.json();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = fields.name.value.trim();
  if (!name) {
    fields.name.focus();
    return;
  }

  if (state.readers.some((reader) => normalizeName(reader.name) === normalizeName(name))) {
    readerRank.textContent = "Name already exists";
    fields.name.focus();
    return;
  }

  const newReader = {
    id: createReaderId(),
    name,
    goals: {
      subjects: readSubjectGoals(fields),
    },
    recordDate: selectedDateKey,
    todayMinutes: 0,
    weekMinutes: 0,
    monthBooks: 0,
  };

  try {
    const data = await addReader(newReader);
    state = {
      currentReaderId: data.currentReaderId,
      readers: data.readers,
    };
    render();
    clearReaderFields();
  } catch (error) {
    readerRank.textContent = getErrorMessage(error, "Save failed");
  }
});

startTimerButton.addEventListener("click", () => {
  const name = timerReaderName.value.trim();
  if (!name) {
    timerReaderName.focus();
    return;
  }

  openSubjectModal();
});

stopTimerButton.addEventListener("click", async () => {
  if (!timerStartedAt) return;

  const name = timerActiveReaderName;
  const elapsedMs = Date.now() - timerStartedAt;

  window.clearInterval(timerInterval);
  timerInterval = null;
  setTimerRunning(false);
  await waitForActiveTimerSave();

  const elapsedWholeMinutes = Math.floor(elapsedMs / 60000);
  const totalMinutes = timerSavedMinutes > 0 ? elapsedWholeMinutes : Math.max(1, Math.ceil(elapsedMs / 60000));
  const unsavedMinutes = totalMinutes - timerSavedMinutes;
  const saved = await saveTimerMinutes(name, unsavedMinutes, `Added ${totalMinutes} min total`);
  timerStartedAt = null;
  timerActiveReaderName = "";
  timerActiveSubject = "";
  timerReaderName.disabled = false;
  updateTimerDisplay();
  setTimerRunning(false);

  if (saved || unsavedMinutes <= 0) {
    if (unsavedMinutes <= 0) {
      timerStatus.textContent = `Added ${timerSavedMinutes} min total`;
    }
    timerSavedMinutes = 0;
  }
});

if (isServerSideBrowser()) {
  resetButton.addEventListener("click", async () => {
    try {
      const data = await clearReaders();
      state = {
        currentReaderId: data.currentReaderId,
        readers: data.readers,
      };
      render();
      clearReaderFields();
    } catch {
      readerRank.textContent = "Reset failed";
    }
  });
}

leaderboardList.addEventListener("click", async (event) => {
  const goalsButton = event.target.closest(".goals-reader-button");
  if (goalsButton) {
    const reader = state.readers.find((item) => item.id === goalsButton.dataset.readerId);
    if (reader) openGoalsModal(reader);
    return;
  }

  const button = event.target.closest(".remove-reader-button");
  if (button) {
    try {
      const data = await removeReader(button.dataset.readerId);
      state = {
        currentReaderId: data.currentReaderId,
        readers: data.readers,
      };
      render();
    } catch {
      readerRank.textContent = "Remove failed";
    }
    return;
  }

});

leaderboardList.addEventListener("mouseover", (event) => {
  const row = event.target.closest(".leader-row");
  if (!row || row.contains(event.relatedTarget)) return;

  const reader = state.readers.find((item) => item.id === row.dataset.readerId);
  if (reader) previewReaderProgress(reader);
});

leaderboardList.addEventListener("mouseout", (event) => {
  const row = event.target.closest(".leader-row");
  if (!row || row.contains(event.relatedTarget)) return;

  restoreCurrentProgress();
});

leaderboardList.addEventListener("focusin", (event) => {
  const row = event.target.closest(".leader-row");
  if (!row) return;

  const reader = state.readers.find((item) => item.id === row.dataset.readerId);
  if (reader) previewReaderProgress(reader);
});

leaderboardList.addEventListener("focusout", (event) => {
  const row = event.target.closest(".leader-row");
  if (!row || row.contains(event.relatedTarget)) return;

  restoreCurrentProgress();
});

goalsModalForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const data = await updateGoals(goalsModalFields.name.value, {
      subjects: readSubjectGoals(goalsModalFields),
    });
    state = {
      currentReaderId: data.currentReaderId,
      readers: data.readers,
    };
    render();
    closeGoalsModal();
    readerRank.textContent = "Goals updated";
  } catch (error) {
    goalsModalMessage.textContent = getErrorMessage(error, "Update failed");
  }
});

closeGoalsModalButton.addEventListener("click", closeGoalsModal);
cancelGoalsUpdateButton.addEventListener("click", closeGoalsModal);
goalsModal.addEventListener("click", (event) => {
  if (event.target === goalsModal) closeGoalsModal();
});

subjectModal.addEventListener("click", (event) => {
  if (event.target === subjectModal) {
    closeSubjectModal();
    return;
  }

  const subjectButton = event.target.closest(".subject-button");
  if (subjectButton) startTimerForSubject(subjectButton.dataset.subject);
});

closeSubjectModalButton.addEventListener("click", closeSubjectModal);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !goalsModal.hidden) closeGoalsModal();
  if (event.key === "Escape" && !subjectModal.hidden) closeSubjectModal();
});

if (progressDate) {
  progressDate.value = selectedDateKey;
  progressDate.addEventListener("change", () => {
    selectedDateKey = progressDate.value || getLocalDateKey();
    render();
  });
}

configureServerOnlyControls();
loadReaders().catch(() => {
  leaderboardList.innerHTML = "";
  const emptyRow = document.createElement("li");
  emptyRow.className = "empty-row";
  emptyRow.textContent = "Open the page from the server URL";
  leaderboardList.append(emptyRow);
  readerRank.textContent = "Server needed";
});
