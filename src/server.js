const express = require("express");
const { Pool } = require("pg");

const PORT = parseInt(process.env.APP_PORT || "3000", 10);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS menu_items (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  price       NUMERIC(8,2) NOT NULL CHECK (price >= 0),
  available   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS orders (
  id            SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  total         NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(8,2) NOT NULL
);
`;

const SEED_MENU = [
  ["Espresso", 1.5],
  ["Americano", 2.0],
  ["Cappuccino", 2.8],
  ["Latte", 3.0],
  ["Flat White", 3.2],
  ["Matcha Latte", 3.5],
];

async function waitForDb(retries = 20, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      console.log(`Database not ready (attempt ${i}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Could not connect to the database");
}

async function initDb() {
  await waitForDb();
  await pool.query(SCHEMA);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM menu_items");
  if (rows[0].n === 0) {
    for (const [name, price] of SEED_MENU) {
      await pool.query("INSERT INTO menu_items (name, price) VALUES ($1, $2)", [name, price]);
    }
    console.log("Seeded default menu");
  }
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "coffee-api",
    endpoints: [
      "GET  /health",
      "GET  /menu",
      "POST /menu            {name, price}",
      "POST /orders          {customer_name, items:[{menu_item_id, quantity}]}",
      "GET  /orders",
      "GET  /orders/:id",
      "GET  /stats",
    ],
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "up" });
  } catch {
    res.status(503).json({ status: "degraded", database: "down" });
  }
});

app.get("/menu", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, price::float AS price, available FROM menu_items ORDER BY id"
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

app.post("/menu", async (req, res, next) => {
  const { name, price } = req.body || {};
  if (typeof name !== "string" || !name.trim() || typeof price !== "number" || price < 0) {
    return res.status(400).json({ error: "name (string) and price (number >= 0) are required" });
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO menu_items (name, price) VALUES ($1, $2) RETURNING id, name, price::float AS price, available",
      [name.trim(), price]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Menu item already exists" });
    next(e);
  }
});

app.post("/orders", async (req, res, next) => {
  const { customer_name, items } = req.body || {};
  if (typeof customer_name !== "string" || !customer_name.trim() || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "customer_name and a non-empty items array are required" });
  }
  for (const it of items) {
    if (!Number.isInteger(it.menu_item_id) || !Number.isInteger(it.quantity) || it.quantity < 1) {
      return res.status(400).json({ error: "each item needs integer menu_item_id and quantity >= 1" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = (
      await client.query("INSERT INTO orders (customer_name) VALUES ($1) RETURNING id, created_at", [
        customer_name.trim(),
      ])
    ).rows[0];

    let total = 0;
    for (const it of items) {
      const menu = await client.query("SELECT price, available FROM menu_items WHERE id = $1", [it.menu_item_id]);
      if (menu.rowCount === 0 || !menu.rows[0].available) {
        await client.query("ROLLBACK");
        return res.status(422).json({ error: `Menu item ${it.menu_item_id} not found or unavailable` });
      }
      const unit = Number(menu.rows[0].price);
      total += unit * it.quantity;
      await client.query(
        "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES ($1, $2, $3, $4)",
        [order.id, it.menu_item_id, it.quantity, unit]
      );
    }
    total = Math.round(total * 100) / 100;
    await client.query("UPDATE orders SET total = $1 WHERE id = $2", [total, order.id]);
    await client.query("COMMIT");
    res.status(201).json({ id: order.id, customer_name: customer_name.trim(), total, created_at: order.created_at });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

app.get("/orders", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, customer_name, total::float AS total, created_at FROM orders ORDER BY id DESC LIMIT 50"
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

app.get("/orders/:id", async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });
  try {
    const order = await pool.query(
      "SELECT id, customer_name, total::float AS total, created_at FROM orders WHERE id = $1",
      [id]
    );
    if (order.rowCount === 0) return res.status(404).json({ error: "order not found" });
    const items = await pool.query(
      `SELECT m.name, oi.quantity, oi.unit_price::float AS unit_price
         FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
        WHERE oi.order_id = $1 ORDER BY oi.id`,
      [id]
    );
    res.json({ ...order.rows[0], items: items.rows });
  } catch (e) {
    next(e);
  }
});

app.get("/stats", async (_req, res, next) => {
  try {
    const totals = await pool.query(
      "SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::float AS revenue FROM orders"
    );
    const top = await pool.query(
      `SELECT m.name, SUM(oi.quantity)::int AS sold
         FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
        GROUP BY m.name ORDER BY sold DESC, m.name LIMIT 3`
    );
    res.json({ ...totals.rows[0], top_sellers: top.rows });
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`coffee-api listening on :${PORT}`)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
