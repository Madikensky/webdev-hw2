# Coffee Shop API: Multi-Container App (Docker Compose)

A small ordering API for a coffee shop. Node.js/Express backend + PostgreSQL, wired together with Docker Compose.

## What it does

- Reads and writes to PostgreSQL: menu items, orders, order line items.
- Order creation runs in a **transaction** (order + items + total computed server-side from DB prices).
- `/stats` aggregates revenue and top sellers from stored data.
- On first start the schema is created and a default menu is seeded.

## Run it

```bash
cp .env.example .env      # then set a real POSTGRES_PASSWORD
docker compose up --build
```

API: http://localhost:3000

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | App + DB status |
| GET | `/menu` | List menu |
| POST | `/menu` | Add item `{ "name": "Mocha", "price": 3.4 }` |
| POST | `/orders` | Create order `{ "customer_name": "Aigerim", "items": [{ "menu_item_id": 1, "quantity": 2 }] }` |
| GET | `/orders` | Latest 50 orders |
| GET | `/orders/:id` | Order with line items |
| GET | `/stats` | Order count, revenue, top 3 sellers |

## Try it

```bash
curl localhost:3000/menu
curl -X POST localhost:3000/orders -H 'Content-Type: application/json' \
  -d '{"customer_name":"Aigerim","items":[{"menu_item_id":3,"quantity":2},{"menu_item_id":1,"quantity":1}]}'
curl localhost:3000/stats
```

## Verify persistence

```bash
docker compose down          # removes containers, keeps the named volume `pgdata`
docker compose up -d
curl localhost:3000/orders   # your orders are still there
```

(`docker compose down -v` deletes the volume and wipes the data.)

## Structure

```
.
├── compose.yaml
├── .env.example      # template, safe to commit
├── .env              # real secrets, git-ignored
├── .gitignore
└── backend/
    ├── Dockerfile
    ├── .dockerignore
    ├── package.json
    └── src/server.js
```

## Design notes

- Services `backend` and `db` share the `backend-net` network; the backend reaches Postgres at host `db`.
- Postgres is **not** published to the host, only the API port is.
- `depends_on` with `condition: service_healthy` + a `pg_isready` healthcheck; the app also retries its connection.
- Compose fails fast with a clear message if required `.env` variables are missing.
- The container runs as the non-root `node` user.
