const express = require("express");
const mysql = require("mysql2/promise");
const { createClient } = require("redis");

const port = Number(process.env.PORT || 8080);
const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true
});

const redis = createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT || 6379)
  },
  password: process.env.REDIS_PASSWORD
});

redis.on("error", (error) => {
  console.error("Redis error:", error.message);
});

async function initializeDatabase() {
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await mysqlPool.query("SELECT COUNT(*) AS count FROM products");
  if (rows[0].count === 0) {
    await mysqlPool.query(
      "INSERT INTO products (name, price) VALUES (?, ?), (?, ?), (?, ?)",
      ["CloudShop Keyboard", 299.00, "CloudShop Mouse", 129.00, "CloudShop Monitor", 1599.00]
    );
  }
}

async function getProducts() {
  const cacheKey = "cloudshop:products:v1";
  const cached = await redis.get(cacheKey);
  if (cached) {
    return { source: "cache", products: JSON.parse(cached) };
  }

  const [products] = await mysqlPool.query(
    "SELECT id, name, price, created_at FROM products ORDER BY id"
  );
  await redis.setEx(cacheKey, 60, JSON.stringify(products));
  return { source: "database", products };
}

async function start() {
  await redis.connect();
  await initializeDatabase();

  const app = express();
  app.use(express.json());

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_request, response, next) => {
    try {
      await mysqlPool.query("SELECT 1");
      await redis.ping();
      response.status(200).json({ status: "ready" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/products", async (_request, response, next) => {
    try {
      response.status(200).json(await getProducts());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/products", async (request, response, next) => {
    try {
      const { name, price } = request.body;
      if (typeof name !== "string" || !name.trim() || !Number.isFinite(Number(price))) {
        response.status(400).json({ error: "name and numeric price are required" });
        return;
      }

      const [result] = await mysqlPool.query(
        "INSERT INTO products (name, price) VALUES (?, ?)",
        [name.trim(), Number(price)]
      );
      await redis.del("cloudshop:products:v1");
      response.status(201).json({ id: result.insertId, name: name.trim(), price: Number(price) });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "internal server error" });
  });

  app.listen(port, () => {
    console.log(`CloudShop API listening on ${port}`);
  });
}

start().catch((error) => {
  console.error("CloudShop API startup failed:", error);
  process.exit(1);
});
