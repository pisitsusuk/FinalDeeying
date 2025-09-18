// routes/uploadSlip.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const router = express.Router();
const { authCheck } = require("../middlewares/auth");

// === โฟลเดอร์เก็บสลิป ===
const SLIP_DIR = path.join(__dirname, "..", "uploads", "slips");
fs.mkdirSync(SLIP_DIR, { recursive: true });

// กัน content-type ผิด
router.use("/payments/slip", (req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (!/^multipart\/form-data/i.test(ct)) {
    return res.status(415).json({
      ok: false,
      message:
        "กรุณาส่งเป็น multipart/form-data และแนบไฟล์ใน field 'slip' หรือ 'file'",
    });
  }
  next();
});

// === Multer ===
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SLIP_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || "") || "").toLowerCase();
    const safeBase = (path.basename(file.originalname || "", ext) || "slip")
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 40);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeBase}${ext}`;
    cb(null, name);
  },
});
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".pdf"]);
const fileFilter = (_req, file, cb) => {
  const mt = (file.mimetype || "").toLowerCase();
  const ext = (path.extname(file.originalname || "") || "").toLowerCase();
  if (ALLOWED_MIME.has(mt) && ALLOWED_EXT.has(ext)) return cb(null, true);
  return cb(new Error("ไฟล์ต้องเป็น JPG/PNG/WEBP/HEIC/PDF และไม่เกิน 10MB"));
};
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter });

// รับได้ทั้ง 'slip' และ 'file'
const acceptSlip = upload.fields([
  { name: "slip", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

/* ---------- helper: เปิดทรานแซกชันตาม dialect ---------- */
async function beginTx(db) {
  if (db.dialect === "postgres") {
    const client = await db.raw.connect(); // pg Pool
    const toPg = (sql) => {
      let i = 0;
      return sql.replace(/\?/g, () => `$${++i}`);
    };
    await client.query("BEGIN");
    return {
      dialect: "postgres",
      query: async (sql, params = []) => {
        const res = await client.query(toPg(sql), params);
        return [res.rows];
      },
      exec: async (sql, params = []) => client.query(toPg(sql), params),
      commit: async () => client.query("COMMIT"),
      rollback: async () => client.query("ROLLBACK"),
      release: () => client.release(),
    };
  }

  // MySQL (mysql2)
  const conn = await db.raw.getConnection();
  await conn.beginTransaction();
  return {
    dialect: "mysql",
    query: (...args) => conn.query(...args),
    exec: (...args) => conn.query(...args),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    release: () => conn.release(),
  };
}

/* ---------- helper: snapshot ตะกร้า → Order / ProductOnOrder (Idempotent; ไม่อ้าง cartId ใน Order) ---------- */
async function snapshotCartToOrder(tx, { userId, cartId, amount }) {
  const isPg = tx.dialect === "postgres";

  // 1) หา order เดิมด้วย (user + amount ใกล้เคียง)
  let orderId = null;
  if (isPg) {
    const [exists] = await tx.query(`
      SELECT o.id
      FROM "Order" o
      WHERE o."orderedById" = ?
        AND ABS(o."cartTotal" - ?) < 0.005
      ORDER BY o."createdAt" DESC
      LIMIT 1
    `, [userId, amount]);
    orderId = exists?.[0]?.id ?? null;
  } else {
    const [exists] = await tx.query(`
      SELECT o.id
      FROM \`Order\` o
      WHERE o.orderedById = ?
        AND ABS(o.cartTotal - ?) < 0.005
      ORDER BY o.createdAt DESC
      LIMIT 1
    `, [userId, amount]);
    orderId = exists?.[0]?.id ?? null;
  }

  // 2) ไม่เจอ → สร้างใหม่
  if (!orderId) {
    const stripeId = `manual-${Date.now()}`;
    const statusStr = "processing";
    const currency  = "THB";
    const amountInt = Math.round(Number(amount) || 0);

    if (isPg) {
      const ins = await tx.exec(`
        INSERT INTO "Order"
          ("cartTotal","orderStatus","orderedById","createdAt","updatedAt",
           "stripePaymentId","amount","status","currentcy")
        VALUES (?, 'Processing', ?, NOW(), NOW(), ?, ?, ?, ?)
        RETURNING id
      `, [amount, userId, stripeId, amountInt, statusStr, currency]);
      orderId = ins.rows[0].id;
    } else {
      const [ins] = await tx.exec(`
        INSERT INTO \`Order\`
          (cartTotal, orderStatus, orderedById, createdAt, updatedAt,
           stripePaymentId, amount, status, currentcy)
        VALUES (?, 'Processing', ?, NOW(), NOW(), ?, ?, ?, ?)
      `, [amount, userId, stripeId, amountInt, statusStr, currency]);
      orderId = ins.insertId;
    }
  }

  // 3) ลบรายการเดิมของออเดอร์ (ทำให้ idempotent)
  if (isPg) {
    await tx.exec(`DELETE FROM "ProductOnOrder" WHERE "orderId" = ?`, [orderId]);
  } else {
    await tx.exec(`DELETE FROM ProductOnOrder WHERE orderId = ?`, [orderId]);
  }

  // 4) รวมจำนวนต่อสินค้าในตะกร้า (เลือกเฉพาะ productId ที่ไม่เป็น NULL) แล้วใส่ใหม่
  if (isPg) {
    const [rows] = await tx.query(`
      SELECT
        pc."productId"                        AS productId,
        SUM(pc."count")::int                  AS qty,
        COALESCE(MIN(pc.price), MIN(p.price), 0) AS price
      FROM "ProductOnCart" pc
      LEFT JOIN "Product" p ON p.id = pc."productId"
      WHERE pc."cartId" = ? AND pc."productId" IS NOT NULL
      GROUP BY pc."productId"
    `, [cartId]);

    for (const r of rows) {
      const pid = Number(r.productId);
      const qty = Number(r.qty || 0);
      if (!pid || qty <= 0) continue; // กันข้อมูลสกปรก
      await tx.exec(
        `INSERT INTO "ProductOnOrder" ("productId","orderId","count","price") VALUES (?, ?, ?, ?)`,
        [pid, orderId, qty, Number(r.price || 0)]
      );
    }
  } else {
    const [rows] = await tx.query(`
      SELECT
        pc.productId                          AS productId,
        SUM(pc.\`count\`)                      AS qty,
        COALESCE(MIN(pc.price), MIN(p.price), 0) AS price
      FROM ProductOnCart pc
      LEFT JOIN Product p ON p.id = pc.productId
      WHERE pc.cartId = ? AND pc.productId IS NOT NULL
      GROUP BY pc.productId
    `, [cartId]);

    for (const r of rows) {
      const pid = Number(r.productId);
      const qty = Number(r.qty || 0);
      if (!pid || qty <= 0) continue;
      await tx.exec(
        `INSERT INTO ProductOnOrder (productId, orderId, \`count\`, price) VALUES (?, ?, ?, ?)`,
        [pid, orderId, qty, Number(r.price || 0)]
      );
    }
  }

  return orderId;
}


/* ============================ ENDPOINT ============================ */
// POST /api/payments/slip  (form-data: cart_id, amount, slip|file[, shipping_address])
router.post("/payments/slip", authCheck, acceptSlip, async (req, res) => {
  const db = req.db;
  let savedFileAbsPath = null;

  const tx = await beginTx(db);
  try {
    const { cart_id, amount, shipping_address } = req.body || {};
    const userId = req.user.id;

    const files = req.files?.slip?.length ? req.files.slip : (req.files?.file || []);
    if (!files.length) return res.status(400).json({ ok: false, message: "กรุณาแนบไฟล์สลิป" });

    const file = files[0];
    savedFileAbsPath = file.path;

    const cartId = Number(String(cart_id || "").trim());
    const amt = Number(String(amount || "").trim());
    if (!Number.isFinite(cartId)) return res.status(400).json({ ok: false, message: "cart_id ไม่ถูกต้อง" });
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, message: "amount ไม่ถูกต้อง" });

    const slipPath = `/uploads/slips/${file.filename}`;

    // ดึง address จาก cart_addresses ถ้าไม่ได้ส่งมา
    let resolvedAddress = (shipping_address || "").trim() || null;
    if (!resolvedAddress) {
      if (tx.dialect === "postgres") {
        const [addrRows] = await tx.query(
          `SELECT address FROM cart_addresses WHERE "cartId" = ? LIMIT 1`,
          [cartId]
        );
        resolvedAddress = addrRows[0]?.address || null;
      } else {
        const [addrRows] = await tx.query(
          `SELECT address FROM cart_addresses WHERE cart_id = ? LIMIT 1`,
          [cartId]
        );
        resolvedAddress = addrRows[0]?.address || null;
      }
    }

    // ---------- บันทึกสลิป และดึง slipId กลับมา ----------
    let slipId;
    if (tx.dialect === "postgres") {
      const [rows] = await tx.query(
        `
        INSERT INTO payment_slips
          (cart_id, user_id, amount, slip_path, status, shipping_address, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, NOW(), NOW())
        RETURNING id
        `,
        [cartId, userId, amt, slipPath, resolvedAddress]
      );
      slipId = rows[0].id;
    } else {
      const [ins] = await tx.exec(
        `
        INSERT INTO payment_slips
          (cart_id, user_id, amount, slip_path, status, shipping_address, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, NOW(), NOW())
        `,
        [cartId, userId, amt, slipPath, resolvedAddress]
      );
      slipId = ins.insertId;
    }

    // ---------- SNAPSHOT ตะกร้า → payment_slip_items ----------
    if (tx.dialect === "postgres") {
      const [cartItemsForSlip] = await tx.query(
        `
        SELECT
          poc."productId"                  AS product_id,
          p.title                          AS title,
          COALESCE(poc.price, p.price, 0)  AS price,
          COALESCE(poc."count", 1)         AS qty
        FROM "ProductOnCart" poc
        LEFT JOIN "Product" p ON p.id = poc."productId"
        WHERE poc."cartId" = ?
        `,
        [cartId]
      );
      for (const it of cartItemsForSlip) {
        await tx.exec(
          `
          INSERT INTO payment_slip_items (slip_id, product_id, title, price, qty, created_at)
          VALUES (?, ?, ?, ?, ?, NOW())
          `,
          [slipId, it.product_id, it.title, Number(it.price || 0), Number(it.qty || 0)]
        );
      }
    } else {
      const [cartItemsForSlip] = await tx.query(
        `
        SELECT
          poc.productId                    AS product_id,
          p.title                          AS title,
          COALESCE(poc.price, p.price, 0)  AS price,
          COALESCE(poc.\`count\`, 1)       AS qty
        FROM ProductOnCart poc
        LEFT JOIN product p ON p.id = poc.productId
        WHERE poc.cartId = ?
        `,
        [cartId]
      );
      for (const it of cartItemsForSlip) {
        await tx.exec(
          `
          INSERT INTO payment_slip_items (slip_id, product_id, title, price, qty, created_at)
          VALUES (?, ?, ?, ?, ?, NOW())
          `,
          [slipId, it.product_id, it.title, Number(it.price || 0), Number(it.qty || 0)]
        );
      }
    }

    // ---------- สร้าง/ผูก Order และ snapshot ลง ProductOnOrder (idempotent) ----------
    const orderId = await snapshotCartToOrder(tx, { userId, cartId, amount: amt });

    await tx.commit();
    return res.json({
      ok: true,
      message: "อัปโหลดสลิปสำเร็จ รอตรวจสอบ",
      order_id: orderId,
      slip_id: slipId,
      slip_path: slipPath,
      shipping_address: resolvedAddress,
    });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    if (savedFileAbsPath) fs.promises.unlink(savedFileAbsPath).catch(() => {});
    console.error("upload slip error:", err?.message || err);
    return res.status(500).json({ ok: false, message: err?.message || "อัปโหลดล้มเหลว" });
  } finally {
    try { tx.release(); } catch {}
  }
});

// error ของ multer
router.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ ok: false, message: "ไฟล์ใหญ่เกิน 10MB" });
  }
  if (typeof err?.message === "string" && /JPG|PNG|WEBP|HEIC|PDF/i.test(err.message)) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  return res.status(500).json({ ok: false, message: "อัปโหลดล้มเหลว" });
});

module.exports = router;
