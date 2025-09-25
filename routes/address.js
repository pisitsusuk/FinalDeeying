// routes/address.js
const express = require("express");
const router = express.Router();
const { authCheck } = require("../middlewares/auth");

/* helpers */
const toStr = (v) => (v == null ? "" : String(v));
const toNum = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

/* =========================================================================
   POST /api/user/address  (บันทึกที่อยู่ผูกกับ cart)
   ========================================================================= */
router.post("/user/address", authCheck, async (req, res) => {
  try {
    const db = req.db;
    const isPg = db.dialect === "postgres";
    const userId = req.user.id;
    const { cartId, address } = req.body || {};

    if (!cartId || !toStr(address).trim()) {
      return res.status(400).json({ ok: false, message: "กรุณาระบุ cartId และ address" });
    }

    // ตรวจว่า cart เป็นของ user นี้
    if (isPg) {
      // Prisma (Postgres): ตาราง "Cart", คอลัมน์ "orderedById"
      const [owns] = await db.query(
        `SELECT id FROM "Cart" WHERE id = ? AND "orderedById" = ? LIMIT 1`,
        [cartId, userId]
      );
      if (!owns.length) return res.status(403).json({ ok: false, message: "ไม่มีสิทธิ์ในตะกร้านี้" });
    } else {
      // MySQL เดิม
      const [owns] = await db.query(
        `SELECT id FROM Cart WHERE id = ? AND orderedById = ? LIMIT 1`,
        [cartId, userId]
      );
      if (!owns.length) return res.status(403).json({ ok: false, message: "ไม่มีสิทธิ์ในตะกร้านี้" });
    }

    // UPSERT address
    const addr = toStr(address).trim();
    if (isPg) {
      // ตารางชื่อ cart_addresses แต่คอลัมน์เป็น camelCase: "cartId"/"createdAt"/"updatedAt"
      await db.query(
        `
        INSERT INTO cart_addresses ("cartId", address, "createdAt", "updatedAt")
        VALUES (?, ?, NOW(), NOW())
        ON CONFLICT ("cartId")
        DO UPDATE SET address = EXCLUDED.address, "updatedAt" = NOW()
        `,
        [cartId, addr]
      );
    } else {
      await db.query(
        `
        INSERT INTO cart_addresses (cart_id, address, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE address = VALUES(address), updated_at = NOW()
        `,
        [cartId, addr]
      );
    }

    return res.json({ ok: true, message: "บันทึกที่อยู่จัดส่งสำเร็จ" });
  } catch (e) {
    console.error("POST /api/user/address error:", e);
    return res.status(500).json({ ok: false, message: "server error" });
  }
});

/* =========================================================================
   GET /api/user/address/my  (รวมจาก payment_slips + cart_addresses)
   ========================================================================= */
router.get("/user/address/my", authCheck, async (req, res) => {
  try {
    const db = req.db;
    const isPg = db.dialect === "postgres";
    const userId = req.user.id;

    // จากสลิปของฉัน (ตาราง payment_slips เป็น snake_case เหมือนเดิม)
    const [slips] = await db.query(
      `
      SELECT
        cart_id          AS "cartId",
        amount           AS "amount",
        shipping_address AS "address",
        created_at       AS "createdAt",
        updated_at       AS "updatedAt"
      FROM payment_slips
      WHERE user_id = ? AND COALESCE(shipping_address,'') <> ''
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 500
      `,
      [userId]
    );

    // จาก cart_addresses ของ cart ที่เป็นของฉัน
    let addrRows = [];
    if (isPg) {
      const [rows] = await db.query(
        `
        SELECT
          ca."cartId"   AS "cartId",
          NULL          AS "amount",
          ca.address    AS "address",
          ca."createdAt" AS "createdAt",
          ca."updatedAt" AS "updatedAt"
        FROM cart_addresses ca
        JOIN "Cart" c ON c.id = ca."cartId"
        WHERE c."orderedById" = ?
        ORDER BY ca."updatedAt" DESC, ca."createdAt" DESC
        LIMIT 500
        `,
        [userId]
      );
      addrRows = rows;
    } else {
      const [rows] = await db.query(
        `
        SELECT
          ca.cart_id    AS cartId,
          NULL          AS amount,
          ca.address    AS address,
          ca.created_at AS createdAt,
          ca.updated_at AS updatedAt
        FROM cart_addresses ca
        JOIN Cart c ON c.id = ca.cart_id
        WHERE c.orderedById = ?
        ORDER BY ca.updated_at DESC, ca.created_at DESC
        LIMIT 500
        `,
        [userId]
      );
      addrRows = rows;
    }

    // รวม & เก็บอันล่าสุดต่อ cartId
    const merged = [...slips, ...addrRows]
      .map((r) => ({
        cartId: r.cartId,
        amount: toNum(r.amount, 0),
        address: toStr(r.address).trim(),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
      .filter((r) => r.cartId != null && r.address);

    const latestByCart = new Map();
    for (const it of merged) {
      const k = String(it.cartId);
      const prev = latestByCart.get(k);
      const t = +new Date(it.updatedAt || it.createdAt);
      const tPrev = prev ? +new Date(prev.updatedAt || prev.createdAt) : -1;
      if (!prev || t > tPrev) latestByCart.set(k, it);
    }

    return res.json({ items: Array.from(latestByCart.values()) });
  } catch (e) {
    console.error("GET /api/user/address/my error:", e);
    return res.status(500).json({ message: "server error" });
  }
});

/* =========================================================================
   GET /api/user/address/resolve?cartId=&amount=&when=
   ========================================================================= */
router.get("/user/address/resolve", authCheck, async (req, res) => {
  try {
    const db = req.db;
    const isPg = db.dialect === "postgres";
    const userId = req.user.id;

    const cartId = req.query.cartId ? Number(req.query.cartId) : null;
    const amount = toNum(req.query.amount, NaN);
    const whenStr = toStr(req.query.when);
    const when = whenStr ? new Date(whenStr) : new Date();

    let address = "";

    // 1) จาก payment_slips ด้วย cartId
    if (cartId != null) {
      const [rows1] = await db.query(
        `
        SELECT shipping_address AS address
        FROM payment_slips
        WHERE user_id = ? AND cart_id = ? AND COALESCE(shipping_address,'') <> ''
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
        `,
        [userId, cartId]
      );
      if (rows1.length && rows1[0].address) address = toStr(rows1[0].address).trim();
    }

    // 2) จาก cart_addresses ของ cart นั้น
    if (!address && cartId != null) {
      if (isPg) {
        const [rows2] = await db.query(
          `
          SELECT ca.address
          FROM cart_addresses ca
          JOIN "Cart" c ON c.id = ca."cartId"
          WHERE ca."cartId" = ? AND c."orderedById" = ?
          LIMIT 1
          `,
          [cartId, userId]
        );
        if (rows2.length && rows2[0].address) address = toStr(rows2[0].address).trim();
      } else {
        const [rows2] = await db.query(
          `
          SELECT ca.address
          FROM cart_addresses ca
          JOIN Cart c ON c.id = ca.cart_id
          WHERE ca.cart_id = ? AND c.orderedById = ?
          LIMIT 1
          `,
          [cartId, userId]
        );
        if (rows2.length && rows2[0].address) address = toStr(rows2[0].address).trim();
      }
    }

    // 3) เทียบยอด + เวลาใกล้กัน
    if (!address && Number.isFinite(amount)) {
      if (isPg) {
        const [rows3] = await db.query(
          `
          SELECT shipping_address AS address, created_at
          FROM payment_slips
          WHERE user_id = ?
            AND COALESCE(shipping_address,'') <> ''
            AND ABS(amount - ?) < 0.005
          ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - ?::timestamp))) ASC
          LIMIT 1
          `,
          [userId, amount, when]
        );
        if (rows3.length && rows3[0].address) address = toStr(rows3[0].address).trim();
      } else {
        const [rows3] = await db.query(
          `
          SELECT shipping_address AS address, created_at
          FROM payment_slips
          WHERE user_id = ?
            AND COALESCE(shipping_address,'') <> ''
            AND ABS(amount - ?) < 0.005
          ORDER BY ABS(TIMESTAMPDIFF(SECOND, created_at, ?)) ASC
          LIMIT 1
          `,
          [userId, amount, when]
        );
        if (rows3.length && rows3[0].address) address = toStr(rows3[0].address).trim();
      }
    }

    return res.json({ address: address || "" });
  } catch (e) {
    console.error("GET /api/user/address/resolve error:", e);
    return res.status(500).json({ message: "server error" });
  }
});

module.exports = router;
