const CATEGORY_META = {
  food: { label: "Food", icon: "🍔", color: "#F87171" },
  transport: { label: "Transport", icon: "🚗", color: "#FACC15" },
  entertainment: { label: "Entertainment", icon: "🎬", color: "#A78BFA" },
  bills: { label: "Bills", icon: "💡", color: "#60A5FA" },
  other: { label: "Other", icon: "📦", color: "#94A3B8" },
};

const CATEGORIES = Object.keys(CATEGORY_META);

function $(sel) {
  return document.querySelector(sel);
}

function money(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function currentMonthLabel() {
  const d = new Date();
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function currentMonthQuery() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

class ExpenseApp {
  constructor() {
    this.expenses = [];
    this.breakdown = [];
    this.ws = null;
    this.reconnectTimer = null;

    this.cache = {
      total: 0,
      count: 0,
      top: null,
    };

    this.init();
  }

  init() {
    this.bindElements();
    this.bindEvents();
    this.setStatus("offline");
    this.connectWebSocket();
    this.loadData();
    $("#current-month").textContent = currentMonthLabel();
  }

  bindElements() {
    this.el = {
      total: $("#total-month"),
      count: $("#tx-count"),
      topCategory: $("#top-category"),
      topCategoryAmount: $("#top-category-amount"),
      chart: $("#breakdown-chart"),
      chartEmpty: $("#chart-empty"),
      legend: $("#legend"),
      transactions: $("#transactions"),
      modal: $("#add-modal"),
      form: $("#add-form"),
      openAdd: $("#open-add"),
      closeAdd: $("#close-add"),
      cancelAdd: $("#cancel-add"),
      submitAdd: $("#submit-add"),
      wsStatus: $("#ws-status"),
      wsText: $("#ws-text"),
    };
  }

  bindEvents() {
    this.el.openAdd.addEventListener("click", () => this.openModal());
    this.el.closeAdd.addEventListener("click", () => this.closeModal());
    this.el.cancelAdd.addEventListener("click", () => this.closeModal());

    this.el.modal.addEventListener("click", (e) => {
      if (e.target === this.el.modal) this.closeModal();
    });

    this.el.modal.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.closeModal();
    });

    this.el.modal.addEventListener("close", (e) => {
      if (e.target.returnValue !== "add-expense") {
        e.preventDefault();
      }
    });

    this.el.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = new FormData(form);
      const category = String(data.get("category") || "");
      const amount = String(data.get("amount") || "");
      const note = String(data.get("note") || "");
      await this.createExpense({ category, amount, note });
      form.reset();
      this.closeModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.el.modal.open) {
        this.closeModal();
      }
      if (e.key === "n" && e.ctrlKey) {
        e.preventDefault();
        this.openModal();
      }
    });
  }

  openModal() {
    this.el.modal.showModal();
    setTimeout(() => this.el.form.category.focus(), 0);
  }

  closeModal() {
    this.el.modal.close();
  }

  setStatus(state) {
    this.el.wsStatus.className = "status-dot";
    if (state === "online") {
      this.el.wsStatus.classList.add("online");
      this.el.wsText.textContent = "Live updates on";
    } else if (state === "offline") {
      this.el.wsStatus.classList.add("offline");
      this.el.wsText.textContent = "Offline";
    } else {
      this.el.wsText.textContent = "Connecting…";
    }
  }

  connectWebSocket() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}${location.pathname.replace(/\/?$/, "")}/`;

    try {
      this.ws = new WebSocket(url);
      this.setStatus("connecting");

      this.ws.addEventListener("open", () => {
        this.setStatus("online");
        this.loadData();
      });

      this.ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "expense:created" || msg.type === "expense:deleted") {
            this.loadData();
          }
        } catch {}
      });

      this.ws.addEventListener("close", () => {
        this.setStatus("offline");
        this.scheduleReconnect();
      });

      this.ws.addEventListener("error", () => {
        this.setStatus("offline");
      });
    } catch {
      this.setStatus("offline");
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 5000);
  }

  async loadData() {
    try {
      const [expensesRes, summaryRes] = await Promise.all([
        fetch(`./api/expenses?month=${currentMonthQuery()}`),
        fetch(`./api/summary?month=${currentMonthQuery()}`),
      ]);

      if (!expensesRes.ok) throw new Error("Failed to load expenses");
      if (!summaryRes.ok) throw new Error("Failed to load summary");

      this.expenses = await expensesRes.json();
      const summary = await summaryRes.json();
      this.breakdown = summary.breakdown || [];

      this.cache.total = summary.total || 0;
      this.cache.count = this.expenses.length;
      this.cache.top = this.breakdown[0] || null;

      this.render();
    } catch (err) {
      this.showToast(err.message || "Error loading expenses", "error");
    }
  }

  async createExpense({ category, amount, note }) {
    this.el.submitAdd.disabled = true;
    try {
      const res = await fetch("./api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, amount, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add expense");
      this.showToast("Expense added");
      await this.loadData();
    } catch (err) {
      this.showToast(err.message, "error");
    } finally {
      this.el.submitAdd.disabled = false;
    }
  }

  async deleteExpense(id) {
    try {
      const res = await fetch(`./api/expenses/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete expense");
      this.showToast("Expense deleted");
      await this.loadData();
    } catch (err) {
      this.showToast(err.message, "error");
    }
  }

  render() {
    this.renderSummary();
    this.renderChart();
    this.renderTransactions();
  }

  renderSummary() {
    this.el.total.textContent = money(this.cache.total);
    this.el.count.textContent = String(this.cache.count);

    if (this.cache.top) {
      this.el.topCategory.textContent = CATEGORY_META[this.cache.top.category]?.label || this.cache.top.category;
      this.el.topCategoryAmount.textContent = money(this.cache.top.total);
    } else {
      this.el.topCategory.textContent = "—";
      this.el.topCategoryAmount.textContent = "$0.00";
    }
  }

  renderChart() {
    if (!this.breakdown.length) {
      this.el.chart.innerHTML = "";
      this.el.chart.appendChild(this.el.chartEmpty.cloneNode(true));
      this.el.legend.innerHTML = "";
      return;
    }

    const max = Math.max(...this.breakdown.map((b) => b.total));
    const total = this.breakdown.reduce((s, b) => s + b.total, 0);

    const list = document.createElement("div");
    list.className = "bar-list";

    this.breakdown.forEach((item) => {
      const meta = CATEGORY_META[item.category] || { label: item.category, color: "#94A3B8" };
      const pct = total > 0 ? Math.round((item.total / total) * 100) : 0;
      const width = max > 0 ? (item.total / max) * 100 : 0;

      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML = `
        <span class="bar-label">${meta.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${width}%; background: ${meta.color}"></div></div>
        <div class="bar-meta">
          <div class="bar-amount">${money(item.total)}</div>
          <div>${pct}%</div>
        </div>
      `;
      list.appendChild(row);
    });

    this.el.chart.innerHTML = "";
    this.el.chart.appendChild(list);

    this.el.legend.innerHTML = this.breakdown
      .map((item) => {
        const meta = CATEGORY_META[item.category] || { label: item.category, color: "#94A3B8" };
        return `
          <span class="legend-item">
            <span class="legend-dot" style="background: ${meta.color}"></span>
            ${meta.label}
          </span>
        `;
      })
      .join("");
  }

  renderTransactions() {
    if (!this.expenses.length) {
      this.el.transactions.innerHTML = `
        <div class="empty-state small">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
          <p>No transactions yet. Add your first expense to get started.</p>
        </div>
      `;
      return;
    }

    this.el.transactions.innerHTML = "";
    this.expenses.forEach((tx) => {
      const meta = CATEGORY_META[tx.category] || { label: tx.category, color: "#94A3B8", icon: "📦" };
      const el = document.createElement("div");
      el.className = "transaction";
      el.innerHTML = `
        <div class="tx-icon" style="background: ${meta.color}20; color: ${meta.color}">${meta.icon}</div>
        <div class="tx-main">
          <div class="tx-category">${meta.label}</div>
          <div class="tx-note">${tx.note || "No note"}</div>
        </div>
        <div>
          <div class="tx-amount">${money(tx.amount)}</div>
          <div class="tx-date">${formatDate(tx.created_at)}</div>
        </div>
        <div class="tx-actions">
          <button type="button" class="btn-icon" data-id="${tx.id}" aria-label="Delete expense">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
        </div>
      `;

      const deleteBtn = el.querySelector(".btn-icon");
      deleteBtn.addEventListener("click", () => {
        if (confirm("Delete this expense?")) {
          this.deleteExpense(tx.id);
        }
      });

      this.el.transactions.appendChild(el);
    });
  }

  showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = "toast" + (type === "error" ? " error" : "");
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add("show");
    });

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 200);
    }, 2400);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new ExpenseApp();
});
