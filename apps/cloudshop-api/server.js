const express = require("express");
const mysql = require("mysql2/promise");
const { createClient } = require("redis");
const client = require("prom-client");
const { validateProductInput, validateStockAdjustment } = require("./product-validation");

const port = Number(process.env.PORT || 8080);
const startupRetryAttempts = Number(process.env.STARTUP_RETRY_ATTEMPTS || 12);
const startupRetryDelayMs = Number(process.env.STARTUP_RETRY_DELAY_MS || 5000);
const metricsRegistry = new client.Registry();

client.collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "cloudshop_api_"
});

const httpRequestDuration = new client.Histogram({
  name: "cloudshop_api_http_request_duration_seconds",
  help: "CloudShop API HTTP request duration in seconds",
  labelNames: ["method", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry]
});

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
      category VARCHAR(80) NOT NULL DEFAULT 'General',
      description TEXT NULL,
      image_url VARCHAR(2048) NULL,
      stock INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await mysqlPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(80) NOT NULL DEFAULT 'General'");
  await mysqlPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT NULL");
  await mysqlPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url VARCHAR(2048) NULL");
  await mysqlPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT UNSIGNED NOT NULL DEFAULT 0");
  await mysqlPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  const [rows] = await mysqlPool.query("SELECT COUNT(*) AS count FROM products");
  if (rows[0].count === 0) {
    await mysqlPool.query(
      "INSERT INTO products (name, price, category, stock) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
      ["CloudShop Keyboard", 299.00, "Accessories", 25, "CloudShop Mouse", 129.00, "Accessories", 40, "CloudShop Monitor", 1599.00, "Displays", 12]
    );
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initializeDependencies() {
  let lastError;

  for (let attempt = 1; attempt <= startupRetryAttempts; attempt += 1) {
    try {
      if (!redis.isReady) {
        if (redis.isOpen) {
          redis.disconnect();
        }
        await redis.connect();
      }

      await initializeDatabase();
      console.log(`CloudShop dependencies ready on attempt ${attempt}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `CloudShop dependency initialization failed on attempt ${attempt}/${startupRetryAttempts}:`,
        error.message
      );

      if (redis.isOpen && !redis.isReady) {
        redis.disconnect();
      }

      if (attempt < startupRetryAttempts) {
        await sleep(startupRetryDelayMs);
      }
    }
  }

  throw lastError;
}


async function getProducts(category) {
  const cacheVersion = (await redis.get("cloudshop:products:version")) || "1";
  const cacheKey = `cloudshop:products:v3:${cacheVersion}:${category || "all"}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return { source: "cache", products: JSON.parse(cached) };
  }

  const query = "SELECT id, name, price, category, description, image_url AS imageUrl, stock, created_at, updated_at FROM products";
  const [products] = category
    ? await mysqlPool.query(`${query} WHERE category = ? ORDER BY id`, [category])
    : await mysqlPool.query(`${query} ORDER BY id`);
  await redis.setEx(cacheKey, 60, JSON.stringify(products));
  return { source: "database", products };
}

async function clearProductsCache() {
  await redis.incr("cloudshop:products:version");
}

async function start() {
  await initializeDependencies();

  const app = express();
  app.use(express.json());
  app.use(express.static("public"));

  app.use((request, response, next) => {
    if (request.path === "/metrics") {
      next();
      return;
    }

    const stopTimer = httpRequestDuration.startTimer();
    response.on("finish", () => {
      stopTimer({
        method: request.method,
        status_code: response.statusCode
      });
    });
    next();
  });

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

  app.get("/metrics", async (_request, response, next) => {
    try {
      response.set("Content-Type", metricsRegistry.contentType);
      response.end(await metricsRegistry.metrics());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/products", async (request, response, next) => {
    try {
      const category = typeof request.query.category === "string" ? request.query.category.trim() : "";
      response.status(200).json(await getProducts(category || undefined));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/products", async (request, response, next) => {
    try {
      const result = validateProductInput(request.body);
      if (result.error) {
        response.status(400).json({ error: result.error });
        return;
      }

      const product = result.value;
      const [insert] = await mysqlPool.query(
        "INSERT INTO products (name, price, category, description, image_url, stock) VALUES (?, ?, ?, ?, ?, ?)",
        [product.name, product.price, product.category, product.description || null, product.imageUrl || null, product.stock]
      );
      await clearProductsCache();
      response.status(201).json({ id: insert.insertId, ...product });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/products/:id", async (request, response, next) => {
    try {
      const [products] = await mysqlPool.query(
        "SELECT id, name, price, category, description, image_url AS imageUrl, stock, created_at, updated_at FROM products WHERE id = ?",
        [request.params.id]
      );
      if (products.length === 0) {
        response.status(404).json({ error: "product not found" });
        return;
      }
      response.status(200).json(products[0]);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/products/:id", async (request, response, next) => {
    try {
      const result = validateProductInput(request.body, { partial: true });
      if (result.error) {
        response.status(400).json({ error: result.error });
        return;
      }
      const product = result.value;
      if (Object.keys(product).length === 0) {
        response.status(400).json({ error: "at least one product field is required" });
        return;
      }

      const columns = [];
      const values = [];
      const columnMap = { name: "name", price: "price", category: "category", description: "description", imageUrl: "image_url", stock: "stock" };
      for (const [key, value] of Object.entries(product)) {
        columns.push(`${columnMap[key]} = ?`);
        values.push(value);
      }
      values.push(request.params.id);
      const [update] = await mysqlPool.query(`UPDATE products SET ${columns.join(", ")} WHERE id = ?`, values);
      if (update.affectedRows === 0) {
        response.status(404).json({ error: "product not found" });
        return;
      }
      await clearProductsCache();
      const [products] = await mysqlPool.query(
        "SELECT id, name, price, category, description, image_url AS imageUrl, stock, created_at, updated_at FROM products WHERE id = ?",
        [request.params.id]
      );
      response.status(200).json(products[0]);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/products/:id/stock", async (request, response, next) => {
    try {
      const result = validateStockAdjustment(request.body);
      if (result.error) {
        response.status(400).json({ error: result.error });
        return;
      }
      const quantity = result.value;
      const [update] = await mysqlPool.query(
        "UPDATE products SET stock = stock + ? WHERE id = ? AND stock + ? >= 0",
        [quantity, request.params.id, quantity]
      );
      if (update.affectedRows === 0) {
        response.status(409).json({ error: "product not found or insufficient stock" });
        return;
      }
      await clearProductsCache();
      const [products] = await mysqlPool.query(
        "SELECT id, name, price, category, description, image_url AS imageUrl, stock, created_at, updated_at FROM products WHERE id = ?",
        [request.params.id]
      );
      response.status(200).json(products[0]);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/categories", async (_request, response, next) => {
    try {
      const [categories] = await mysqlPool.query("SELECT DISTINCT category FROM products ORDER BY category");
      response.status(200).json({ categories: categories.map((row) => row.category) });
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
