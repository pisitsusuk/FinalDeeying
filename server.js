// server.js
require("dotenv").config();

const express = require("express");
const app = express();
const morgan = require("morgan");
const { readdirSync } = require("fs");
const fs = require("fs");
const cors = require("cors");
const dialogflow = require("@google-cloud/dialogflow");
const uuid = require("uuid");
const path = require("path");
const bodyParser = require("body-parser");

// DB libs
const mysql = require("mysql2");
const { Pool } = require("pg");

// ===== Route modules =====
const uploadSlipRoutes = require("./routes/uploadSlip");
const orderRoutes = require("./routes/order");
const slipAdminRoutes = require("./routes/slipAdmin");
const imageRoutes = require("./routes/image");
const adminMetricsRoutes = require("./routes/adminMetrics");
const adminBankInfoRoutes = require("./routes/adminBankInfo");
const addressRoutes = require("./routes/address"); // ที่อยู่จัดส่ง
const productRoutes = require("./routes/product");
// ===== CORS =====
const ALLOW_ORIGINS = [
  "https://deeying-system.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000"
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOW_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200,
  })
);

// ===== Body parsers =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// ===== Env warns =====
[
  "JWT_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "DIALOGFLOW_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
].forEach((k) => {
  if (!process.env[k]) console.warn(`[WARN] Missing env ${k}`);
});

// ===== Core middleware =====
app.use(morgan("dev"));

// ===== Metrics =====
app.use("/api", adminMetricsRoutes);

// ===== DB wrapper (PG first, fallback MySQL) =====
function makeDB() {
  // ใช้ CONNECTION_POOL_URL หากมี ไม่งั้นใช้ DATABASE_URL
  const url = process.env.CONNECTION_POOL_URL || process.env.DATABASE_URL || "";
  const isPg = /^postgres(ql)?:\/\//i.test(url);

  if (isPg) {
    const pool = new Pool({
      connectionString: url,
      ssl:
        process.env.PG_SSL === "1" || /render|heroku|supabase/i.test(url)
          ? { rejectUnauthorized: false }
          : undefined,
      max: 3, // ลดเหลือ 3 connections สำหรับ Supabase Free
      min: 0, // ไม่ต้องรักษา connection ไว้
      idleTimeoutMillis: 5000, // ปิด connection ที่ไม่ใช้เร็วขึ้น
      connectionTimeoutMillis: 15000, // เพิ่มเวลา timeout
      acquireTimeoutMillis: 15000, // เพิ่มเวลา acquire timeout
      maxUses: 500, // ลด usage per connection
      allowExitOnIdle: true, // กลับไปใช้ true เพื่อปิด pool เมื่อไม่ใช้
    });

    // Handle pool errors
    pool.on('error', (err) => {
      console.error('[PG Pool] Unexpected error on idle client', err);
    });

    // Monitor pool status
    pool.on('connect', () => {
      console.log('[PG Pool] New client connected');
    });

    pool.on('remove', () => {
      console.log('[PG Pool] Client removed');
    });

    // Periodic cleanup of idle connections
    setInterval(async () => {
      const poolInfo = {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      };
      console.log('[PG Pool] Status:', poolInfo);

      // หาก idle connections เยอะเกินไป ให้ปิดบางส่วน
      if (pool.idleCount > 2) {
        console.log('[PG Pool] Cleaning up idle connections');
      }
    }, 30000); // ตรวจสอบทุก 30 วินาที

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('[PG Pool] Closing pool...');
      await pool.end();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('[PG Pool] Closing pool...');
      await pool.end();
      process.exit(0);
    });

    const query = async (sql, params = []) => {
      // แปลง ? -> $1,$2,... สำหรับ PG
      let i = 0;
      const text = sql.replace(/\?/g, () => `$${++i}`);

      // Retry logic สำหรับ connection errors
      const maxRetries = 3;
      let retries = 0;

      while (retries < maxRetries) {
        try {
          const { rows } = await pool.query(text, params);
          return [rows];
        } catch (error) {
          retries++;
          console.error(`[PG Query] Attempt ${retries}/${maxRetries} failed:`, error.message);

          // หาก error เกี่ยวกับ connection และยังพอมีครั้งให้ retry
          if (retries < maxRetries && (
            error.code === 'ECONNRESET' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ETIMEDOUT' ||
            error.message.includes('Connection terminated') ||
            error.message.includes("Can't reach database server")
          )) {
            // รอ 1 วินาทีก่อน retry
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            continue;
          }

          // หากไม่ใช่ connection error หรือ retry หมดแล้ว ให้ throw error
          throw error;
        }
      }
    };
    const db = { dialect: "postgres", query, raw: pool };
    return db;
  }

  // MySQL (local)
  const pool = url
    ? mysql.createPool(url + "?charset=utf8mb4")
    : mysql.createPool({
        host: process.env.DB_HOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASS || "",
        database: process.env.DB_NAME || "deeying",
        charset: "utf8mb4",
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        acquireTimeout: 30000,
        timeout: 30000,
        idleTimeout: 300000,
        reconnect: true,
      });

  const db = {
    dialect: "mysql",
    query: (...args) => pool.promise().query(...args),
    raw: pool,
  };
  return db;
}

const db = makeDB();
console.log(`[DB] dialect = ${db.dialect}`);
app.use((req, _res, next) => {
  req.db = db;
  next();
});

// ===== Static =====
const UP_DIR = path.join(__dirname, "uploads", "slips");
fs.mkdirSync(UP_DIR, { recursive: true });
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ===== Health =====
app.get("/healthz", async (req, res) => {
  try {
    // ตรวจสอบการเชื่อมต่อฐานข้อมูล
    await req.db.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("[Health Check] Database error:", error.message);
    res.status(503).json({ ok: false, database: "disconnected", error: error.message });
  }
});

/* =======================================================================
 *  Main Routes (สำคัญ: addressRoutes มาก่อน orderRoutes)
 * ======================================================================= */
app.use("/api", uploadSlipRoutes);
app.use("/api", slipAdminRoutes);
app.use("/api", adminBankInfoRoutes);
app.use("/api", addressRoutes);  // <<<<< ให้ตัวนี้มาก่อน
app.use("/api", orderRoutes);
app.use("/api", imageRoutes);
app.use("/api", productRoutes);
/* =======================================================================
 *                    DIALOGFLOW + PRICE CHAT HANDLER
 * ======================================================================= */
let sessionClient = null;
try {
    sessionClient = new dialogflow.SessionsClient();
  console.log("[DF] ready project =", process.env.DIALOGFLOW_PROJECT_ID);
} catch (e) {
  console.error("[DF] init error:", e.message || e);
}

async function detectIntentDF(message, userId = "anon") {
  if (!sessionClient || !process.env.DIALOGFLOW_PROJECT_ID) return null;
  const sessionId = `${userId}-${uuid.v4()}`;
  const sessionPath = sessionClient.projectAgentSessionPath(
    process.env.DIALOGFLOW_PROJECT_ID,
    sessionId
  );
  const request = {
    session: sessionPath,
    queryInput: { text: { text: message, languageCode: "th-TH" } },
    queryParams: { timeZone: "Asia/Bangkok" },
  };
  const resp = await sessionClient.detectIntent(request);
  return resp?.[0]?.queryResult || {};
}

const pickProductParam = (fields = {}) =>
  fields.product?.stringValue ||
  fields.Product?.stringValue ||
  fields["สินค้า"]?.stringValue ||
  fields.any?.stringValue ||
  null;

const extractProductFromText = (text = "") => {
  let t = text.replace(/\s+/g, " ").replace(/[?？！!]/g, "").trim();
  t = t
    .replace(/(ราคา|price|เท่าไร|เท่าไหร่|กี่บาท)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
};



// ... โค้ดส่วนบน (เหมือนเดิม) ...

async function findProductInDB(dbWrap, name) {
  // 1. แปลงชื่อสินค้าที่ต้องการค้นหาให้เป็นตัวพิมพ์เล็กทั้งหมดและลบเครื่องหมายพิเศษ
  const cleanName = name.replace(/\s*:\s*/g, " ").trim().toLowerCase(); // เปลี่ยนจาก Azano Model : JL-168 เป็น azano model jl-168

  // 2. ปรับคำสั่ง SQL ให้ใช้ ILIKE (Case-Insensitive)
  const [rows] = await dbWrap.query(
    `SELECT id, title, price, quantity
     FROM "Product"
     WHERE (deleted IS NULL OR deleted = false)
     AND LOWER(title) LIKE ?
     LIMIT 1`,
    [`%${cleanName}%`]
  );

  // 3. ตรวจสอบผลลัพธ์
  return rows?.[0] || null;
}

// ... โค้ดส่วนล่าง (เหมือนเดิม) ...


async function chatHandler(req, res) {
  const message = (req.body?.message ?? req.body?.text ?? req.body?.q ?? "")
    .toString()
    .trim();
  if (!message) return res.status(400).json({ reply: "กรุณาระบุข้อความ" });

  try {
    const result = await detectIntentDF(message);
    const intent = result?.intent?.displayName || null;
    let productName = pickProductParam(result?.parameters?.fields);

    let finalIntent = intent;
    if (finalIntent === "ถามราคาสินค้า" && !productName)
      productName = extractProductFromText(message);
    if (!finalIntent && /(ราคา|price)/i.test(message)) {
      finalIntent = "ถามราคาสินค้า";
      if (!productName) productName = extractProductFromText(message);
    }

    if (finalIntent === "ถามราคาสินค้า" && productName) {
      const p = await findProductInDB(req.db, productName);
      if (!p) return res.json({ reply: `ยังไม่พบ “${productName}” ในคลังสินค้า` });
      return res.json({
        reply: `สินค้าของเราคือ “${p.title}” ดูรายละเอียดได้ที่ด้านล่างครับ  👇`,
        rich: {
          type: "product_suggestion",
          product: {
            id: p.id,
            title: p.title,
            price: Number(p.price) || 0,
            quantity: Number(p.quantity) || 0,
          },
        },
      });
    }

    if (result?.fulfillmentText)
      return res.json({ reply: result.fulfillmentText });
    return res.json({ reply: "ขออภัย ฉันไม่เข้าใจคำถาม" });
  } catch (e) {
    console.error("/chat error:", e);
    return res
      .status(500)
      .json({ reply: "ขออภัย ระบบขัดข้อง ลองใหม่อีกครั้งครับ" });
  }
}

// ... โค้ดส่วนล่างของ chatHandler ...

// Endpoint สำหรับการค้นหาโดยตรง (ใช้สำหรับปุ่ม "ถามราคาสินค้า")
app.post("/api/chat/search", async (req, res) => {
  const message = (req.body?.message ?? req.body?.text ?? req.body?.q ?? "").toString().trim();
  if (!message) {
    return res.status(400).json({ reply: "กรุณาระบุข้อความ" });
  }

  const p = await findProductInDB(req.db, message);
  if (!p) return res.json({ reply: `ยังไม่พบ “${message}” ในคลังสินค้า` });

  return res.json({
    reply: `สินค้าของเราคือ “${p.title}” ดูรายละเอียดได้ที่ด้านล่างครับ 👇`,
    rich: {
      type: "product_suggestion",
      product: {
        id: p.id,
        title: p.title,
        price: Number(p.price) || 0,
        quantity: Number(p.quantity) || 0,
      },
    },
  });
});

// ... โค้ดที่เหลือ (เหมือนเดิม) ...



app.post("/chat", chatHandler);
app.post("/api/chat", chatHandler);

/* =======================================================================
 *                           AUTO-LOAD OTHER ROUTES
 * ======================================================================= */
const routesDir = path.join(__dirname, "routes");
const skip = new Set([
  "uploadSlip.js",
  "slipAdmin.js",
  "order.js",
  "image.js",
  "adminMetrics.js",
  "adminBankInfo.js",
  "address.js",
]);
readdirSync(routesDir).forEach((file) => {
  if (skip.has(file)) return;
  app.use("/api", require(path.join(routesDir, file)));
});

// ===== 404 & Error Handler =====
app.use((req, res) => res.status(404).json({ message: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ message: "Server error", detail: err?.message });
});

// ===== Start =====
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
