import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

const CATEGORIES = ["food", "transport", "entertainment", "bills", "other"] as const;

type Expense = {
  id: number;
  category: string;
  amount: number;
  note: string;
  created_at: number;
};

function nowMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class App extends DurableObject {
  private app = new Hono()
    .get("/api/expenses", async (c) => {
      this.ensureSchema();
      const month = c.req.query("month") ?? nowMonth();
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, category, amount, note, created_at FROM expenses
           WHERE strftime('%Y-%m', created_at / 1000, 'unixepoch') = ?
           ORDER BY created_at DESC`,
          month
        )
        .toArray() as Expense[];
      return c.json(rows);
    })
    .get("/api/expenses/all", async (c) => {
      this.ensureSchema();
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, category, amount, note, created_at FROM expenses ORDER BY created_at DESC LIMIT 100`
        )
        .toArray() as Expense[];
      return c.json(rows);
    })
    .post("/api/expenses", async (c) => {
      this.ensureSchema();
      const body = await c.req.json<{
        category?: string;
        amount?: number | string;
        note?: string;
      }>();

      const category = String(body.category ?? "").toLowerCase().trim();
      if (!CATEGORIES.includes(category as any)) {
        return c.json({ error: "Invalid category" }, 400);
      }

      const rawAmount = body.amount;
      const amount =
        typeof rawAmount === "string" ? parseFloat(rawAmount) : Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return c.json({ error: "Amount must be a positive number" }, 400);
      }

      const note = String(body.note ?? "").trim();

      const result = this.ctx.storage.sql.exec(
        `INSERT INTO expenses (category, amount, note, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
        category,
        amount,
        note,
        Date.now()
      );
      const inserted = result.toArray()[0] as { id: number };
      this.broadcast("expense:created", { id: inserted.id });
      return c.json({ id: inserted.id, category, amount, note }, 201);
    })
    .delete("/api/expenses/:id", async (c) => {
      this.ensureSchema();
      const id = Number(c.req.param("id"));
      if (!Number.isFinite(id)) {
        return c.json({ error: "Invalid id" }, 400);
      }
      this.ctx.storage.sql.exec(`DELETE FROM expenses WHERE id = ?`, id);
      this.broadcast("expense:deleted", { id });
      return c.json({ ok: true });
    })
    .get("/api/summary", async (c) => {
      this.ensureSchema();
      const month = c.req.query("month") ?? nowMonth();
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses
           WHERE strftime('%Y-%m', created_at / 1000, 'unixepoch') = ?
           GROUP BY category
           ORDER BY total DESC`,
          month
        )
        .toArray() as { category: string; total: number }[];

      const grandTotal = rows.reduce((sum, r) => sum + Number(r.total), 0);
      return c.json({ month, total: grandTotal, breakdown: rows });
    });

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/api/ws") && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }
    return this.app.fetch(request);
  }

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses (created_at)`
    );
  }

  private handleWebSocket(request: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(type: string, payload: Record<string, unknown>) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type, ...payload }));
      } catch {
        // ignore closed sockets
      }
    }
  }
}
