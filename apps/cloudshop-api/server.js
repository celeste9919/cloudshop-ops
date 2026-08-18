const express = require("express");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const { createClient } = require("redis");
const client = require("prom-client");
const { validateProductInput, validateStockAdjustment } = require("./product-validation");

const sessionCookie = "cloudshop_session";
const sessionTtlSeconds = 7 * 24 * 60 * 60;

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

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(120) NOT NULL,
      role ENUM('customer', 'admin') NOT NULL DEFAULT 'customer',
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY users_email_unique (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role ENUM('customer', 'admin') NOT NULL DEFAULT 'customer'");
  if (process.env.CLOUDSHOP_ADMIN_EMAIL && process.env.CLOUDSHOP_ADMIN_PASSWORD) {
    const adminEmail = process.env.CLOUDSHOP_ADMIN_EMAIL.trim().toLowerCase();
    if (/^\S+@\S+\.\S+$/.test(adminEmail) && process.env.CLOUDSHOP_ADMIN_PASSWORD.length >= 8) {
      await mysqlPool.query(
        "INSERT INTO users (email, name, role, password_hash) VALUES (?, 'CloudShop Admin', 'admin', ?) ON DUPLICATE KEY UPDATE role = 'admin'",
        [adminEmail, hashPassword(process.env.CLOUDSHOP_ADMIN_PASSWORD)]
      );
    }
  }
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id BIGINT UNSIGNED NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      quantity INT UNSIGNED NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      status ENUM('pending_payment', 'paid', 'cancelled') NOT NULL DEFAULT 'pending_payment',
      total DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      product_name VARCHAR(120) NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      quantity INT UNSIGNED NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, expected] = encoded.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function cookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

async function currentUser(request) {
  const token = cookies(request)[sessionCookie];
  if (!token) return null;
  const userId = await redis.get(`cloudshop:session:${token}`);
  if (!userId) return null;
  const [users] = await mysqlPool.query("SELECT id, email, name, role, created_at FROM users WHERE id = ?", [userId]);
  return users[0] || null;
}

async function requireUser(request, response, next) {
  try {
    const user = await currentUser(request);
    if (!user) {
      response.status(401).json({ error: "authentication required" });
      return;
    }
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(request, response, next) {
  await requireUser(request, response, (error) => {
    if (error) {
      next(error);
      return;
    }
    if (request.user.role !== "admin") {
      response.status(403).json({ error: "administrator access required" });
      return;
    }
    next();
  });
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

  app.post("/api/auth/register", async (request, response, next) => {
    try {
      const email = typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : "";
      const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
      const password = typeof request.body.password === "string" ? request.body.password : "";
      if (!/^\S+@\S+\.\S+$/.test(email) || !name || name.length > 120 || password.length < 8) {
        response.status(400).json({ error: "valid email, name, and password of at least 8 characters are required" });
        return;
      }
      const [result] = await mysqlPool.query(
        "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)",
        [email, name, hashPassword(password)]
      );
      response.status(201).json({ id: result.insertId, email, name });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        response.status(409).json({ error: "email is already registered" });
        return;
      }
      next(error);
    }
  });

  app.post("/api/auth/login", async (request, response, next) => {
    try {
      const email = typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : "";
      const password = typeof request.body.password === "string" ? request.body.password : "";
      const [users] = await mysqlPool.query("SELECT id, email, name, role, password_hash FROM users WHERE email = ?", [email]);
      if (users.length === 0 || !verifyPassword(password, users[0].password_hash)) {
        response.status(401).json({ error: "invalid email or password" });
        return;
      }
      const token = crypto.randomBytes(32).toString("hex");
      await redis.setEx(`cloudshop:session:${token}`, sessionTtlSeconds, String(users[0].id));
      response.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}; Path=/`);
      response.status(200).json({ id: users[0].id, email: users[0].email, name: users[0].name, role: users[0].role });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", async (request, response, next) => {
    try {
      const token = cookies(request)[sessionCookie];
      if (token) await redis.del(`cloudshop:session:${token}`);
      response.setHeader("Set-Cookie", `${sessionCookie}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/me", requireUser, (request, response) => {
    response.status(200).json(request.user);
  });

  app.get("/api/cart", requireUser, async (request, response, next) => {
    try {
      const [items] = await mysqlPool.query(
        "SELECT c.product_id AS productId, c.quantity, p.name, p.price, p.image_url AS imageUrl, p.stock FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.user_id = ? ORDER BY c.updated_at DESC",
        [request.user.id]
      );
      response.status(200).json({ items, total: items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/cart/items/:productId", requireUser, async (request, response, next) => {
    try {
      const quantity = Number(request.body.quantity);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
        response.status(400).json({ error: "quantity must be a whole number between 0 and 1000000" });
        return;
      }
      if (quantity === 0) {
        await mysqlPool.query("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?", [request.user.id, request.params.productId]);
      } else {
        const [products] = await mysqlPool.query("SELECT id, stock FROM products WHERE id = ?", [request.params.productId]);
        if (products.length === 0) {
          response.status(404).json({ error: "product not found" });
          return;
        }
        if (quantity > products[0].stock) {
          response.status(409).json({ error: "quantity exceeds available stock" });
          return;
        }
        await mysqlPool.query(
          "INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)",
          [request.user.id, request.params.productId, quantity]
        );
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/orders", requireUser, async (request, response, next) => {
    let connection;
    try {
      connection = await mysqlPool.getConnection();
      await connection.beginTransaction();
      const [items] = await connection.query(
        "SELECT c.product_id AS productId, c.quantity, p.name, p.price, p.stock FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.user_id = ? FOR UPDATE",
        [request.user.id]
      );
      if (items.length === 0) {
        await connection.rollback();
        response.status(400).json({ error: "cart is empty" });
        return;
      }
      if (items.some((item) => item.quantity > item.stock)) {
        await connection.rollback();
        response.status(409).json({ error: "one or more products no longer have enough stock" });
        return;
      }
      const total = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
      const [order] = await connection.query("INSERT INTO orders (user_id, total) VALUES (?, ?)", [request.user.id, total]);
      for (const item of items) {
        await connection.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)", [order.insertId, item.productId, item.name, item.price, item.quantity]);
        await connection.query("UPDATE products SET stock = stock - ? WHERE id = ?", [item.quantity, item.productId]);
      }
      await connection.query("DELETE FROM cart_items WHERE user_id = ?", [request.user.id]);
      await connection.commit();
      await clearProductsCache();
      response.status(201).json({ id: order.insertId, status: "pending_payment", total });
    } catch (error) {
      if (connection) await connection.rollback();
      next(error);
    } finally {
      if (connection) connection.release();
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

  app.post("/api/products", requireAdmin, async (request, response, next) => {
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

  app.patch("/api/products/:id", requireAdmin, async (request, response, next) => {
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

  app.post("/api/products/:id/stock", requireAdmin, async (request, response, next) => {
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
