"use strict";

const $ = (id) => document.getElementById(id);

const BILL_TYPES = [
  { id: "electricity", name: "Electricity bill" },
  { id: "internet", name: "Internet bill" },
  { id: "water", name: "Water bill" },
  { id: "gas", name: "Gas bill" },
  { id: "rent", name: "Rent" }
];

const MAX_AMOUNT = 100000000000;

let db;
let state;
let ready = false;
let selectedMonth = today().slice(0, 7);
let activeFilter = "all";
let saveQueue = Promise.resolve();
let installPrompt = null;
let toastTimer;

function today() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function defaultState() {
  return {
    version: 1,
    currency: "LKR",
    months: {}
  };
}

function emptyMonth() {
  return {
    opening: 0,
    contributions: [],
    expenses: []
  };
}

function monthData() {
  return state.months[selectedMonth] || emptyMonth();
}

function ensureMonth(next, monthKey) {
  if (!next.months[monthKey]) {
    next.months[monthKey] = emptyMonth();
  }

  return next.months[monthKey];
}

function makeId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]
  );
}

function parseMoney(value, allowZero = false, allowNegative = false) {
  const text = String(value).trim();

  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(
      "Enter a valid amount with no more than two decimal places."
    );
  }

  const amount = Math.round(Number(text) * 100);

  if (
    !Number.isSafeInteger(amount) ||
    Math.abs(amount) > MAX_AMOUNT ||
    (!allowNegative && amount < 0) ||
    (!allowZero && amount === 0)
  ) {
    throw new Error("Enter a valid amount.");
  }

  return amount;
}

function money(value) {
  const formatted = new Intl.NumberFormat("en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value / 100);

  return `${state.currency} ${formatted}`;
}

function totals(month) {
  const income = month.contributions.reduce(
    (sum, item) => sum + item.amount,
    0
  );

  const expenses = month.expenses.reduce(
    (sum, item) => sum + item.amount,
    0
  );

  return {
    income,
    expenses,
    balance: month.opening + income - expenses
  };
}

function validMonth(value) {
  return (
    /^\d{4}-(0[1-9]|1[0-2])$/.test(value) &&
    Number(value.slice(0, 4)) >= 1900
  );
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T12:00:00Z`);

  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function defaultDate() {
  return selectedMonth === today().slice(0, 7)
    ? today()
    : `${selectedMonth}-01`;
}

function previousMonth() {
  const [year, month] = selectedMonth.split("-").map(Number);

  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function monthTitle(value) {
  const [year, month] = value.split("-").map(Number);

  return new Date(year, month - 1, 1).toLocaleDateString(
    "en",
    { year: "numeric", month: "long" }
  );
}

function toast(message) {
  clearTimeout(toastTimer);

  $("toast").textContent = message;
  $("toast").classList.add("show");

  toastTimer = setTimeout(() => {
    $("toast").classList.remove("show");
  }, 3500);
}

function showError(message) {
  $("appError").hidden = false;
  $("appError").textContent = message;
}

function validateState(raw) {
  if (
    !raw ||
    raw.version !== 1 ||
    !["LKR", "JPY", "USD"].includes(raw.currency) ||
    !raw.months ||
    typeof raw.months !== "object" ||
    Array.isArray(raw.months)
  ) {
    throw new Error("Invalid Household Budget backup.");
  }

  const clean = defaultState();
  clean.currency = raw.currency;

  const keys = Object.keys(raw.months);

  if (keys.length > 1200) {
    throw new Error("Too many months in this backup.");
  }

  let recordCount = 0;

  for (const key of keys) {
    if (!validMonth(key)) {
      throw new Error("The backup contains an invalid month.");
    }

    const source = raw.months[key];

    if (
      !source ||
      !Number.isSafeInteger(source.opening) ||
      Math.abs(source.opening) > MAX_AMOUNT ||
      !Array.isArray(source.contributions) ||
      !Array.isArray(source.expenses)
    ) {
      throw new Error("Invalid monthly data.");
    }

    const month = emptyMonth();
    month.opening = source.opening;

    const usedIds = new Set();
    const usedBills = new Set();

    for (const collection of ["contributions", "expenses"]) {
      for (const item of source[collection]) {
        recordCount++;

        if (
          recordCount > 50000 ||
          !item ||
          typeof item.id !== "string" ||
          !item.id ||
          item.id.length > 100 ||
          usedIds.has(item.id) ||
          typeof item.name !== "string" ||
          !item.name.trim() ||
          item.name.length > 80 ||
          !Number.isSafeInteger(item.amount) ||
          item.amount <= 0 ||
          item.amount > MAX_AMOUNT ||
          !validDate(item.date) ||
          item.date.slice(0, 7) !== key
        ) {
          throw new Error("Invalid transaction in backup.");
        }

        usedIds.add(item.id);

        const entry = {
          id: item.id,
          name: item.name.trim(),
          amount: item.amount,
          date: item.date
        };

        if (collection === "expenses") {
          const bill = BILL_TYPES.find(
            (bill) => bill.id === item.category
          );

          if (item.category !== "extra" && !bill) {
            throw new Error("Invalid expense category.");
          }

          entry.category = item.category;

          if (bill) {
            if (usedBills.has(bill.id)) {
              throw new Error("Duplicate monthly bill.");
            }

            usedBills.add(bill.id);
            entry.name = bill.name;
          }
        }

        month[collection].push(entry);
      }
    }

    const summary = totals(month);

    if (
      !Number.isSafeInteger(summary.income) ||
      !Number.isSafeInteger(summary.expenses) ||
      !Number.isSafeInteger(summary.balance)
    ) {
      throw new Error("The total amount is too large.");
    }

    clean.months[key] = month;
  }

  return clean;
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openDatabase() {
  if (!("indexedDB" in window)) {
    throw new Error("IndexedDB is unavailable in this browser.");
  }

  const request = indexedDB.open("household-budget-db", 1);

  request.onupgradeneeded = () => {
    request.result.createObjectStore("data");
  };

  request.onblocked = () => {
    showError(
      "Close other tabs using this app, then reload this page."
    );
  };

  db = await readRequest(request);

  db.onversionchange = () => {
    db.close();
    ready = false;
    $("appControls").disabled = true;

    showError(
      "The database was updated. Reload this page to continue."
    );
  };

  const saved = await readRequest(
    db.transaction("data", "readonly")
      .objectStore("data")
      .get("household")
  );

  state = saved ? validateState(saved) : defaultState();
}

function readSavedState() {
  return readRequest(
    db.transaction("data", "readonly")
      .objectStore("data")
      .get("household")
  );
}

// Reading and writing use one transaction.
// This prevents one tab from overwriting another tab's new entries.
function writeChange(change) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("data", "readwrite");
    const store = transaction.objectStore("data");
    const request = store.get("household");

    let updated;
    let problem;

    request.onsuccess = () => {
      try {
        const next = request.result
          ? validateState(request.result)
          : defaultState();

        change(next);
        updated = validateState(next);

        store.put(updated, "household");
      } catch (error) {
        problem = error;
        transaction.abort();
      }
    };

    transaction.oncomplete = () => resolve(updated);

    transaction.onerror = () => {
      reject(problem || transaction.error);
    };

    transaction.onabort = () => {
      reject(
        problem ||
        transaction.error ||
        new Error("Saving was cancelled.")
      );
    };
  });
}

function save(change, message) {
  const operation = saveQueue.then(async () => {
    if (!ready) {
      throw new Error("Storage is not ready. Reload the page.");
    }

    state = await writeChange(change);
    render();

    if (message) {
      toast(message);
    }
  });

  saveQueue = operation.catch(() => {});

  return operation;
}

function showSaveError(error) {
  appAlert(
    "Your changes were not saved.\n" +
    "Check browser storage and try again.\n\n" +
    error.message
  );
}

function transactionHTML(item) {
  return `
    <div class="transaction">
      <div class="transaction-info">
        <div class="transaction-name">
          ${escapeHTML(item.name)}
        </div>

        <div class="transaction-detail">
          ${item.date}
          ·
          ${
            item.kind === "income"
              ? "Contribution"
              : item.category === "extra"
                ? "Additional expense"
                : "Monthly bill"
          }
        </div>
      </div>

      <span class="record-amount ${
        item.kind === "income"
          ? "income-amount"
          : "expense-amount"
      }">
        ${item.kind === "income" ? "+" : "−"}
        ${money(item.amount)}
      </span>

      <div class="record-actions">
        <button
          type="button"
          data-edit="${escapeHTML(item.id)}"
          data-kind="${item.kind}"
        >
          Edit
        </button>

        <button
          type="button"
          class="delete"
          data-delete="${escapeHTML(item.id)}"
          data-kind="${item.kind}"
        >
          Delete
        </button>
      </div>
    </div>
  `;
}

function render() {
  const month = monthData();
  const summary = totals(month);

  $("monthPicker").value = selectedMonth;
  $("monthLabel").textContent = monthTitle(selectedMonth);
  $("currencyPicker").value = state.currency;

  $("balanceTotal").textContent = money(summary.balance);
  $("incomeTotal").textContent = money(summary.income);
  $("expenseTotal").textContent = money(summary.expenses);

  $("balanceLabel").textContent =
    summary.balance < 0 ? "Amount short" : "Available balance";

  document.querySelector(".balance-card")
    .classList.toggle("negative", summary.balance < 0);

  $("incomeCount").textContent =
    `${month.contributions.length} entries`;

  $("expenseCount").textContent =
    `${month.expenses.length} entries`;

  $("openingAmount").value =
    (month.opening / 100).toFixed(2);

  const previous = state.months[previousMonth()];

  $("carryForward").hidden = !previous;

  if (previous) {
    $("carryForward").textContent =
      "Use previous month's balance: " +
      money(totals(previous).balance);
  }

  $("billsList").innerHTML = BILL_TYPES.map((bill) => {
    const entry = month.expenses.find(
      (item) => item.category === bill.id
    );

    return `
      <form class="bill-row" data-bill="${bill.id}">
        <label for="bill-${bill.id}">
          ${bill.name}
        </label>

        <input
          id="bill-${bill.id}"
          name="amount"
          type="number"
          step="0.01"
          min="0"
          max="1000000000"
          inputmode="decimal"
          placeholder="0.00"
          value="${
            entry ? (entry.amount / 100).toFixed(2) : ""
          }"
          required
        >

        <button type="submit">Save</button>
      </form>
    `;
  }).join("");

  const people = new Map();

  for (const contribution of month.contributions) {
    const key = contribution.name.trim().toLocaleLowerCase();

    const person = people.get(key) || {
      name: contribution.name,
      total: 0,
      count: 0
    };

    person.total += contribution.amount;
    person.count++;

    people.set(key, person);
  }

  $("peopleCount").textContent = `${people.size} people`;

$("peopleList").innerHTML = people.size
  ? [...people.values()]
      .sort((a, b) => b.total - a.total)
      .map((person) => `
        <div class="person">
          <div class="person-info">
            <div class="person-name">
              ${escapeHTML(person.name)}
            </div>

            <div class="person-detail">
              ${person.count} contribution(s)
            </div>
          </div>

          <span class="record-amount">
            ${money(person.total)}
          </span>

          <div class="person-controls">
            <button
              type="button"
              data-edit-person="${escapeHTML(person.name)}"
            >
              Edit
            </button>

            <button
              type="button"
              class="person-delete"
              data-delete-person="${escapeHTML(person.name)}"
            >
              Delete
            </button>
          </div>
        </div>
      `)
      .join("")
  : '<p class="empty">No contributions yet.</p>';
  const extras = month.expenses
    .filter((item) => item.category === "extra")
    .map((item) => ({ ...item, kind: "expense" }));

  $("extrasList").innerHTML = extras.length
    ? [...extras].reverse().map(transactionHTML).join("")
    : '<p class="empty">No additional expenses yet.</p>';

  const transactions = [
    ...month.contributions.map(
      (item) => ({ ...item, kind: "income" })
    ),

    ...month.expenses.map(
      (item) => ({ ...item, kind: "expense" })
    )
  ]
    .filter(
      (item) =>
        activeFilter === "all" ||
        item.kind === activeFilter
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.id.localeCompare(a.id)
    );

  $("transactionsList").innerHTML = transactions.length
    ? transactions.map(transactionHTML).join("")
    : '<p class="empty">No matching transactions this month.</p>';

  document.querySelectorAll("[data-filter]")
    .forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.filter === activeFilter)
      );
    });
}

function setDefaultDates() {
  $("incomeDate").value = defaultDate();
  $("expenseDate").value = defaultDate();
}

$("monthPicker").addEventListener("change", () => {
  const value = $("monthPicker").value;

  if (!validMonth(value)) {
    $("monthPicker").value = selectedMonth;
    return;
  }

  selectedMonth = value;
  setDefaultDates();
  render();
});

$("openingForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const monthKey = selectedMonth;
  const button = event.submitter;
  button.disabled = true;

  try {
    const amount = parseMoney(
      $("openingAmount").value,
      true,
      true
    );

    await save((next) => {
      ensureMonth(next, monthKey).opening = amount;
    }, "Opening balance saved.");
  } catch (error) {
    showSaveError(error);
  } finally {
    button.disabled = false;
  }
});

$("carryForward").addEventListener("click", async () => {
  const monthKey = selectedMonth;
  const previousKey = previousMonth();

  if (!state.months[previousKey]) {
    return;
  }

  const approved = await appConfirm(
  "Replace this month's opening balance with " +
  "the previous month's available balance?"
);

  if (!approved) return;

  try {
    await save((next) => {
      const previous = next.months[previousKey];

      if (!previous) {
        throw new Error("The previous month was not found.");
      }

      ensureMonth(next, monthKey).opening =
        totals(previous).balance;
    }, "Previous balance carried forward.");
  } catch (error) {
    showSaveError(error);
  }
});

$("incomeForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const button = event.submitter;
  button.disabled = true;

  try {
    const name = $("personName").value.trim();
    const amount = parseMoney($("personAmount").value);
    const date = $("incomeDate").value;
    const monthKey = selectedMonth;

    if (!name || name.length > 80) {
      throw new Error("Enter a name between 1 and 80 characters.");
    }

    if (!validDate(date) || date.slice(0, 7) !== monthKey) {
      throw new Error("Choose a date within the selected month.");
    }

    await save((next) => {
      ensureMonth(next, monthKey).contributions.push({
        id: makeId(),
        name,
        amount,
        date
      });
    }, "Contribution added.");

    $("incomeForm").reset();
    $("incomeDate").value = defaultDate();
    $("personName").focus();
  } catch (error) {
    showSaveError(error);
  } finally {
    button.disabled = false;
  }
});

$("billsList").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-bill]");

  if (!form) return;

  event.preventDefault();

  const button = event.submitter;
  button.disabled = true;

  try {
    const amount = parseMoney(
      form.elements.amount.value,
      true
    );

    const bill = BILL_TYPES.find(
      (item) => item.id === form.dataset.bill
    );

    if (!bill) throw new Error("Unknown bill.");

    const monthKey = selectedMonth;
    const date = defaultDate();

    await save((next) => {
      const month = ensureMonth(next, monthKey);

      const existing = month.expenses.find(
        (item) => item.category === bill.id
      );

      if (amount === 0) {
        month.expenses = month.expenses.filter(
          (item) => item.category !== bill.id
        );
      } else if (existing) {
        existing.amount = amount;
      } else {
        month.expenses.push({
          id: makeId(),
          name: bill.name,
          category: bill.id,
          amount,
          date
        });
      }
    }, "Bill saved.");
  } catch (error) {
    showSaveError(error);
  } finally {
    button.disabled = false;
  }
});

$("toggleExpense").addEventListener("click", () => {
  const form = $("expenseForm");

  form.hidden = !form.hidden;

  $("toggleExpense").textContent =
    form.hidden ? "+ Add expense" : "Close";

  if (!form.hidden) {
    $("expenseDate").value = defaultDate();
    $("expenseName").focus();
  }
});

$("expenseForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const button = event.submitter;
  button.disabled = true;

  try {
    const name = $("expenseName").value.trim();
    const amount = parseMoney($("expenseAmount").value);
    const date = $("expenseDate").value;
    const monthKey = selectedMonth;

    if (!name || name.length > 80) {
      throw new Error("Enter a name between 1 and 80 characters.");
    }

    if (!validDate(date) || date.slice(0, 7) !== monthKey) {
      throw new Error("Choose a date within the selected month.");
    }

    await save((next) => {
      ensureMonth(next, monthKey).expenses.push({
        id: makeId(),
        name,
        amount,
        date,
        category: "extra"
      });
    }, "Expense added.");

    $("expenseForm").reset();
    $("expenseForm").hidden = true;
    $("toggleExpense").textContent = "+ Add expense";
    $("expenseDate").value = defaultDate();
  } catch (error) {
    showSaveError(error);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const filterButton = event.target.closest("[data-filter]");

  if (filterButton) {
    activeFilter = filterButton.dataset.filter;
    render();
    return;
  }

  const button = event.target.closest(
    "[data-edit], [data-delete]"
  );

  if (!button || !ready) return;

  const collection = button.dataset.kind === "income"
    ? "contributions"
    : "expenses";

  const monthKey = selectedMonth;
  const id = button.dataset.edit || button.dataset.delete;

  const item = monthData()[collection].find(
    (entry) => entry.id === id
  );

  if (!item) return;

  if (button.hasAttribute("data-delete")) {
   if (!await appConfirm(
  `Delete "${item.name}"?\n\nThis entry will be removed and your balance will be recalculated.`
)) {
  return;
}

    try {
      await save((next) => {
        const month = ensureMonth(next, monthKey);

        month[collection] = month[collection].filter(
          (entry) => entry.id !== id
        );
      }, "Entry deleted.");
    } catch (error) {
      showSaveError(error);
    }

    return;
  }

  const isFixedBill =
    collection === "expenses" &&
    item.category !== "extra";

 const enteredName = isFixedBill
  ? item.name
  : await appPrompt("Name:", item.name);

if (enteredName === null) return;

const enteredAmount = await appPrompt(
  "Amount:",
  (item.amount / 100).toFixed(2)
);

if (enteredAmount === null) return;

const enteredDate = await appPrompt(
  "Date (YYYY-MM-DD):",
  item.date
);

if (enteredDate === null) return;
  try {
    const name = enteredName.trim();
    const amount = parseMoney(enteredAmount);
    const date = enteredDate.trim();

    if (!name || name.length > 80) {
      throw new Error("Enter a name between 1 and 80 characters.");
    }

    if (!validDate(date) || date.slice(0, 7) !== monthKey) {
      throw new Error("Choose a date within the selected month.");
    }

    await save((next) => {
      const entry = ensureMonth(next, monthKey)[collection]
        .find((record) => record.id === id);

      if (!entry) {
        throw new Error("The entry no longer exists.");
      }

      entry.name = name;
      entry.amount = amount;
      entry.date = date;
    }, "Entry updated.");
  } catch (error) {
    showSaveError(error);
  }
});

$("currencyPicker").addEventListener("change", async () => {
  const currency = $("currencyPicker").value;

  try {
    await save((next) => {
      next.currency = currency;
    }, "Currency label updated.");
  } catch (error) {
    $("currencyPicker").value = state.currency;
    showSaveError(error);
  }
});

$("downloadBackup").addEventListener("click", async () => {
  try {
    await saveQueue;

    const saved = await readSavedState();

    const backup = saved
      ? validateState(saved)
      : defaultState();

    const blob = new Blob(
      [JSON.stringify(backup, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `household-budget-${today()}.json`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 30000);

    toast(
      "Backup download started. Check that the file was saved."
    );
  } catch (error) {
   appAlert("Unable to create backup.\n\n" + error.message);
  }
});

$("restoreBackup").addEventListener("change", async (event) => {
  const file = event.target.files[0];

  if (!file) return;

  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error("Choose a backup smaller than 10 MB.");
    }

    const backup = validateState(
      JSON.parse(await file.text())
    );

   const approved = await appConfirm(
  "Restore this backup?\n\n" +
  "This replaces ALL months currently saved in this browser. " +
  "Download a backup of your current data first."
);

    if (!approved) return;

    await save((next) => {
      next.currency = backup.currency;
      next.months = backup.months;
    }, "Backup restored.");
  } catch (error) {
   appAlert("Unable to restore backup.\n\n" + error.message);
  } finally {
    event.target.value = "";
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("installButton").hidden = false;
});

$("installButton").addEventListener("click", async () => {
  if (!installPrompt) return;

  await installPrompt.prompt();
  await installPrompt.userChoice;

  installPrompt = null;
  $("installButton").hidden = true;
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("installButton").hidden = true;
});

// Refresh committed data when returning from another tab.
document.addEventListener("visibilitychange", async () => {
  if (
    document.visibilityState !== "visible" ||
    !ready
  ) {
    return;
  }

  try {
    await saveQueue;

    const saved = await readSavedState();

    state = saved
      ? validateState(saved)
      : defaultState();

    render();
  } catch (error) {
    showError("Unable to refresh saved data. " + error.message);
  }
});

async function setupOffline() {
  const canRegister =
    "serviceWorker" in navigator &&
    (
      location.protocol === "https:" ||
      ["localhost", "127.0.0.1"].includes(location.hostname)
    );

  if (!canRegister) {
    $("offlineStatus").textContent =
      "Use HTTPS hosting or localhost to enable offline support.";

    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.ready;

    $("offlineStatus").textContent =
      "Offline app files are ready on this browser.";
  } catch {
    $("offlineStatus").textContent =
      "Offline setup failed. Reopen the app while online to try again.";
  }
}

async function start() {
  $("monthPicker").value = selectedMonth;
  setDefaultDates();

  try {
    await openDatabase();

    ready = true;
    render();
    $("appControls").disabled = false;
  } catch (error) {
    showError(
      "Unable to open browser storage. Enable site storage " +
      "and reload this page. " +
      error.message
    );
  }

  await setupOffline();
}

start();

// App screen navigation.
// Financial data and calculations continue using the existing code.

const SCREEN_DETAILS = {
  dashboard: {
    title: "Dashboard",
    description: "A quick look at your household finances."
  },

  contributions: {
    title: "Contributions",
    description: "Add money and see each person's contribution."
  },

  expenses: {
    title: "Bills & expenses",
    description: "Keep track of your household spending."
  },

  history: {
    title: "Transaction history",
    description: "Review and manage your monthly entries."
  },

  settings: {
    title: "Settings",
    description: "Manage your currency, backups, and app."
  }
};

function showScreen(screenName, moveFocus = false) {
  if (!Object.hasOwn(SCREEN_DETAILS, screenName)) {
    screenName = "dashboard";
  }

  document.querySelectorAll("[data-screen]")
    .forEach((screen) => {
      screen.hidden =
        screen.dataset.screen !== screenName;
    });

  document.querySelectorAll("[data-screen-target]")
    .forEach((button) => {
      const selected =
        button.dataset.screenTarget === screenName;

      if (selected) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });

  const details = SCREEN_DETAILS[screenName];

  document.getElementById("screenTitle").textContent =
    details.title;

  document.getElementById("screenDescription").textContent =
    details.description;

  document.title =
    `${details.title} | Household Budget`;

  window.scrollTo({
    top: 0,
    behavior: "instant"
  });

  if (moveFocus) {
    const heading = document.getElementById("screenTitle");

    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
}


function navigateToScreen(screenName) {
  if (!Object.hasOwn(SCREEN_DETAILS, screenName)) {
    return;
  }

  const hash = `#${screenName}`;

  if (location.hash === hash) {
    showScreen(screenName, true);
  } else {
    location.hash = screenName;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(
    "[data-screen-target], [data-go-screen]"
  );

  if (!button) return;

  const screenName =
    button.dataset.screenTarget ||
    button.dataset.goScreen;

  navigateToScreen(screenName);
});

window.addEventListener("hashchange", () => {
  const screenName = location.hash.slice(1);

  showScreen(screenName, true);
});

// Open the correct screen after refresh.
showScreen(
  location.hash.slice(1) || "dashboard"
);

$("clearOpening").addEventListener("click", async () => {
  if (!ready) return;

  const approved = await appConfirm(
  "Clear this month's opening balance?\n\n" +
  "The previous month's records will not be changed."
);

  if (!approved) return;

  const monthKey = selectedMonth;
  const button = $("clearOpening");

  button.disabled = true;

  try {
    await save((next) => {
      ensureMonth(next, monthKey).opening = 0;
    }, "Opening balance cleared.");
  } catch (error) {
    showSaveError(error);
  } finally {
    button.disabled = false;
  }
});

// Queue popups so that two messages never overlap.
let popupQueue = Promise.resolve();

function openAppPopup({
  type = "alert",
  title = "Household Budget",
  message = "",
  value = "",
  confirmText = "OK",
  danger = false
}) {
  const task = popupQueue.then(() => {
    return new Promise((resolve) => {
      const dialog = document.getElementById("appDialog");
      const form = document.getElementById("appDialogForm");

      const titleElement =
        document.getElementById("popupTitle");

      const messageElement =
        document.getElementById("popupMessage");

      const icon = document.getElementById("popupIcon");

      const inputLabel =
        document.getElementById("popupInputLabel");

      const inputText =
        document.getElementById("popupInputText");

      const input = document.getElementById("popupInput");

      const cancelButton =
        document.getElementById("popupCancel");

      const confirmButton =
        document.getElementById("popupConfirm");

      const previousFocus = document.activeElement;

      titleElement.textContent = title;
      messageElement.textContent = message;

      dialog.dataset.danger = String(danger);

      icon.textContent = type === "prompt"
        ? "✎"
        : danger
          ? "!"
          : "i";

      inputLabel.hidden = type !== "prompt";
      input.required = type === "prompt";
      input.value = String(value);
      inputText.textContent = message || "Value";

      // For edit popups, use the label rather than duplicate text.
      messageElement.hidden = type === "prompt";

      cancelButton.hidden = type === "alert";
      confirmButton.textContent = confirmText;

      let finished = false;

      function finish(result) {
        if (finished) return;
        finished = true;

        form.removeEventListener("submit", onSubmit);

        cancelButton.removeEventListener(
          "click",
          onCancel
        );

        dialog.removeEventListener("cancel", onEscape);

        dialog.close();

        if (previousFocus?.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }

        resolve(result);
      }

      function onSubmit(event) {
        event.preventDefault();

        finish(
          type === "prompt"
            ? input.value
            : true
        );
      }

      function onCancel() {
        finish(type === "prompt" ? null : false);
      }

      function onEscape(event) {
        event.preventDefault();

        finish(
          type === "prompt"
            ? null
            : type === "alert"
              ? true
              : false
        );
      }

      form.addEventListener("submit", onSubmit);

      cancelButton.addEventListener("click", onCancel);

      dialog.addEventListener("cancel", onEscape);

      dialog.showModal();

      if (type === "prompt") {
        input.focus();
        input.select();
      } else if (type === "confirm") {
        cancelButton.focus();
      } else {
        confirmButton.focus();
      }
    });
  });

  popupQueue = task.catch(() => {});

  return task;
}

function appAlert(message) {
  return openAppPopup({
    type: "alert",
    title: "Please check",
    message,
    confirmText: "Got it"
  });
}

function appConfirm(message) {
  return openAppPopup({
    type: "confirm",
    title: "Confirm action",
    message,
    confirmText: "Confirm",
    danger: true
  });
}

function appPrompt(message, value = "") {
  return openAppPopup({
    type: "prompt",
    title: "Edit details",
    message,
    value,
    confirmText: "Continue"
  });
}

document.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-person]");
  const deleteButton = event.target.closest("[data-delete-person]");

  if ((!editButton && !deleteButton) || !ready) return;

  const button = editButton || deleteButton;
  const personName = editButton
    ? button.dataset.editPerson
    : button.dataset.deletePerson;

  const personKey = personName.trim().toLocaleLowerCase();
  const monthKey = selectedMonth;
  const belongsToPerson = (entry) =>
    entry.name.trim().toLocaleLowerCase() === personKey;

  const entries = monthData().contributions.filter(belongsToPerson);
  if (!entries.length) return;

  try {
    if (editButton) {
      const enteredName = await appPrompt("Person's name:", personName);
      if (enteredName === null) return;

      const newName = enteredName.trim();
      if (!newName || newName.length > 80) {
        await appAlert("Enter a name between 1 and 80 characters.");
        return;
      }

      const updatedAmounts = new Map();

      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const label = entries.length === 1
          ? "Contribution amount:"
          : `Contribution ${index + 1} of ${entries.length} — ${entry.date}\nAmount:`;

        const value = await appPrompt(label, (entry.amount / 100).toFixed(2));
        if (value === null) return;

        try {
          updatedAmounts.set(entry.id, parseMoney(value));
        } catch (error) {
          await appAlert(error.message);
          return;
        }
      }

      await save((next) => {
        const month = ensureMonth(next, monthKey);

        for (const entry of entries) {
          const current = month.contributions.find(
            (item) => item.id === entry.id
          );

          if (!current || !belongsToPerson(current) || current.amount !== entry.amount) {
            throw new Error("A contribution changed. Please try editing again.");
          }
        }

        for (const entry of month.contributions) {
          if (belongsToPerson(entry)) {
            entry.name = newName;
            if (updatedAmounts.has(entry.id)) {
              entry.amount = updatedAmounts.get(entry.id);
            }
          }
        }
      }, "Name and contribution amounts updated.");

      return;
    }

    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    const approved = await appConfirm(
      `Delete "${personName}" from this month?\n\n` +
      `${entries.length} contribution(s), totalling ${money(total)}, will be removed.\n\n` +
      "Your balance will be recalculated. Other months will not be changed."
    );

    if (!approved) return;

    await save((next) => {
      const month = ensureMonth(next, monthKey);
      month.contributions = month.contributions.filter(
        (entry) => !belongsToPerson(entry)
      );
    }, "Person's contributions removed.");
  } catch (error) {
    showSaveError(error);
  }
});
