// server/routes/slipAdmin.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { authCheck, adminCheck } = require("../middlewares/auth");

/* helper: สร้าง URL เต็มจาก slip_path */
function publicUrlFromPath(req, p) {
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  const origin = `${req.protocol}://${req.get("host")}`;
  return `${origin}${p.startsWith("/") ? "" : "/"}${p}`;
}

/* ------------------------------------------------------------------ */
/* ------------------------ STOCK HELPERS ---------------------------- */
/* ------------------------------------------------------------------ */

async function fetchSlipCore(db, id) {
  const [rows] = await db.query(
    `SELECT id, status, cart_id, user_id, amount FROM payment_slips WHERE id = ?`,
    [id]
  );
  return rows?.[0] || null;
}

/** อัปเดตธง stock_deducted แบบอะตอมมิก – คืน true ถ้า “เพิ่ง” เซ็ตได้ */
async function markDeductFlagAtomically(db, slipId) {
  const isPg = db.dialect === "postgres";
  if (isPg) {
    const [rows] = await db
      .query(
        `
        UPDATE payment_slips
           SET stock_deducted = TRUE
         WHERE id = ?
           AND COALESCE(stock_deducted, FALSE) = FALSE
        RETURNING id
        `,
        [slipId]
      )
      .catch(() => [[]]);
    return !!rows?.length;
  }
  const [res] = await db
    .query(
      `
      UPDATE payment_slips
         SET stock_deducted = TRUE
       WHERE id = ?
         AND COALESCE(stock_deducted, FALSE) = FALSE
      `,
      [slipId]
    )
    .catch(() => [{}]);
  const affected = res?.affectedRows ?? res?.rowCount ?? 0;
  return affected > 0;
}

/** หักสต็อกจาก ProductOnCart ตาม cartId (Postgres) — ป้องกันขายเกิน */
async function pgDeductFromCart(db, cartId) {
  try {
    const [r] = await db.query(
      `
      WITH s AS (
        SELECT "productId" AS pid, SUM("count")::int AS qty
        FROM "ProductOnCart"
        WHERE "cartId" = ?
        GROUP BY "productId"
      )
      UPDATE "Product" p
         SET quantity = GREATEST(p.quantity - s.qty, 0),
             sold     = p.sold + LEAST(s.qty, p.quantity)
      FROM s
      WHERE p.id = s.pid
      `,
      [cartId]
    );
    return r?.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/** หา orderId จาก slip: ใช้ cartId ก่อน, ไม่เจอค่อยหา orderedById+amount (Postgres) */
async function pgFindOrderId(db, slip) {
  try {
    if (slip.cart_id != null) {
      const [r1] = await db.query(
        `SELECT o.id FROM "Order" o WHERE o."cartId" = ? ORDER BY o."createdAt" DESC LIMIT 1`,
        [slip.cart_id]
      );
      if (r1?.length) return r1[0].id;
    }
  } catch {}
  try {
    if (slip.user_id != null && slip.amount != null) {
      const [r2] = await db.query(
        `
        SELECT o.id
        FROM "Order" o
        WHERE o."orderedById" = ?
          AND ROUND(o."cartTotal"::numeric, 2) = ROUND(?::numeric, 2)
        ORDER BY o."createdAt" DESC
        LIMIT 1
        `,
        [slip.user_id, slip.amount]
      );
      if (r2?.length) return r2[0].id;
    }
  } catch {}
  return null;
}

/** หักสต็อกจาก ProductOnOrder ตาม orderId (Postgres) — ป้องกันขายเกิน */
async function pgDeductFromOrder(db, orderId) {
  try {
    const [r] = await db.query(
      `
      WITH s AS (
        SELECT "productId" AS pid, SUM("count")::int AS qty
        FROM "ProductOnOrder"
        WHERE "orderId" = ?
        GROUP BY "productId"
      )
      UPDATE "Product" p
         SET quantity = GREATEST(p.quantity - s.qty, 0),
             sold     = p.sold + LEAST(s.qty, p.quantity)
      FROM s
      WHERE p.id = s.pid
      `,
      [orderId]
    );
    return r?.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/* ---------------------------- Fallback (MySQL) ---------------------------- */
async function mysqlFetchItemsAny(db, slip) {
  let items = [];
  try {
    if (slip.cart_id != null) {
      const [r] = await db.query(
        `SELECT productId AS productId, \`count\` AS qty FROM ProductOnCart WHERE cartId = ?`,
        [slip.cart_id]
      );
      items = r;
    }
  } catch {}
  if (items?.length) return items;

  try {
    const [o] = await db.query(
      `SELECT id FROM \`Order\` WHERE cartId = ? ORDER BY createdAt DESC LIMIT 1`,
      [slip.cart_id]
    );
    const oid = o?.[0]?.id;
    if (oid) {
      const [r] = await db.query(
        `SELECT productId AS productId, \`count\` AS qty FROM ProductOnOrder WHERE orderId = ?`,
        [oid]
      );
      items = r;
    }
  } catch {}
  return items || [];
}

async function mysqlUpdatePerItem(db, rows) {
  for (const it of rows || []) {
    const pid = Number(it.productId);
    const qty = Number(it.qty || it.count || 0);
    if (!pid || !qty) continue;

    // ตาราง product (ตัวพิมพ์เล็ก)
    await db
      .query(
        `UPDATE product
           SET sold = sold + LEAST(quantity, ?),
               quantity = GREATEST(quantity - ?, 0)
         WHERE id = ?`,
        [qty, qty, pid]
      )
      .catch(() => {});
    // ตาราง "Product" (Prisma/Postgres style)
    await db
      .query(
        `UPDATE "Product"
           SET sold = sold + LEAST(quantity, ?),
               quantity = GREATEST(quantity - ?, 0)
         WHERE id = ?`,
        [qty, qty, pid]
      )
      .catch(() => {});
  }
}

/** หักสต็อกหนึ่งครั้งต่อสลิป: อนุมัติแล้วค่อยอ่าน snapshot (payment_slip_items) */
async function deductStockIfApprove(db, prevStatus, nextStatus, slip) {
  if (String(nextStatus).toUpperCase() !== "APPROVED") return;

  // เคย APPROVED อยู่แล้ว → แค่พยายามตั้งธงให้สอดคล้องแล้วออก
  if (String(prevStatus).toUpperCase() === "APPROVED") {
    await markDeductFlagAtomically(db, slip.id);
    return;
  }

  // อนุมัติจากสถานะอื่น → ให้ตัดเฉพาะ “ครั้งแรกจริง ๆ” เท่านั้น (กันซ้ำแบบอะตอมมิก)
  const firstTime = await markDeductFlagAtomically(db, slip.id);
  if (!firstTime) return;

  const isPg = db.dialect === "postgres";

  // 1) รวมยอดจาก snapshot ของสลิปใบนี้
  let rows = [];
  if (isPg) {
    const [r] = await db.query(
      `
      SELECT product_id AS pid, SUM(qty)::int AS qty
      FROM payment_slip_items
      WHERE slip_id = ?
        AND product_id IS NOT NULL
      GROUP BY product_id
      `,
      [slip.id]
    );
    rows = r;
  } else {
    const [r] = await db.query(
      `
      SELECT product_id AS pid, SUM(qty) AS qty
      FROM payment_slip_items
      WHERE slip_id = ?
        AND product_id IS NOT NULL
      GROUP BY product_id
      `,
      [slip.id]
    );
    rows = r;
  }

  // 2) อัปเดต stock/sold แบบปลอดภัย (หักเท่าที่มีจริง) — รองรับทั้ง product และ "Product"
  for (const it of rows || []) {
    const pid = Number(it.pid);
    const qty = Number(it.qty || 0);
    if (!pid || qty <= 0) continue;

    // ตาราง product (ตัวพิมพ์เล็ก)
    await db
      .query(
        `UPDATE product
           SET quantity = GREATEST(quantity - ?, 0),
               sold     = sold + LEAST(?, quantity)
         WHERE id = ?`,
        [qty, qty, pid]
      )
      .catch(() => {});

    // ตาราง "Product" (Prisma/Postgres)
    await db
      .query(
        `UPDATE "Product"
           SET quantity = GREATEST(quantity - ?, 0),
               sold     = sold + LEAST(?, quantity)
         WHERE id = ?`,
        [qty, qty, pid]
      )
      .catch(() => {});
  }
}


/* =========================== ADMIN: รายการสลิป =========================== */
// GET /api/admin/approve?status=PENDING|APPROVED|REJECTED (ค่าว่าง=ทั้งหมด)
router.get("/admin/approve", authCheck, adminCheck, async (req, res) => {
  try {
    const db = req.db;
    const isPg = db.dialect === "postgres";

    const allow = new Set(["PENDING", "APPROVED", "REJECTED"]);
    const f = String(req.query.status || "").toUpperCase().trim();
    const hasFilter = allow.has(f);

    let slipRows = [];
    if (isPg) {
      const [rows] = await db.query(
        `
        SELECT
          ps.id,
          ps.cart_id                    AS "cartId",
          ps.user_id                    AS "userId",
          u.name                        AS "userName",
          u.email                       AS "userEmail",
          ps.amount,
          ps.status,
          ps.slip_path                  AS "slip_path",
          COALESCE(ps.shipping_address, ca.address) AS "shippingAddress",
          ps.created_at                 AS "createdAt",
          ps.updated_at                 AS "updatedAt"
        FROM payment_slips ps
        LEFT JOIN "User" u          ON u.id = ps.user_id
        LEFT JOIN cart_addresses ca ON ca."cartId" = ps.cart_id
        ${hasFilter ? "WHERE ps.status = ?" : ""}
        ORDER BY ps.created_at DESC
        `,
        hasFilter ? [f] : []
      );
      slipRows = rows;
    } else {
      const [rows] = await db.query(
        `
        SELECT
          ps.id,
          ps.cart_id             AS cartId,
          ps.user_id             AS userId,
          u.name                 AS userName,
          u.email                AS userEmail,
          ps.amount,
          ps.status,
          ps.slip_path           AS slip_path,
          COALESCE(ps.shipping_address, ca.address) AS shippingAddress,
          ps.created_at          AS createdAt,
          ps.updated_at          AS updatedAt
        FROM payment_slips ps
        LEFT JOIN \`User\` u        ON u.id = ps.user_id
        LEFT JOIN cart_addresses ca ON ca.cart_id = ps.cart_id
        ${hasFilter ? "WHERE ps.status = ?" : ""}
        ORDER BY ps.created_at DESC
        `,
        hasFilter ? [f] : []
      );
      slipRows = rows;
    }

    if (!Array.isArray(slipRows) || !slipRows.length) {
      return res.json({ ok: true, items: [] });
    }

    // ดึงสินค้าจาก Cart
    const cartIds = [...new Set(slipRows.map((x) => x.cartId).filter(Boolean))];
    let cartMap = {};
    if (cartIds.length) {
      if (isPg) {
        const [cartItems] = await db.query(
          `
          SELECT
            pc."cartId"                  AS "cartId",
            pc."productId"               AS "productId",
            pc."count"                   AS "qty",
            COALESCE(pc.price, p.price)  AS "price",
            p.title                      AS "title"
          FROM "ProductOnCart" pc
          LEFT JOIN "Product" p ON p.id = pc."productId"
          WHERE pc."cartId" = ANY (?)
          `,
          [cartIds]
        );
        cartMap = cartItems.reduce((acc, r) => {
          (acc[r.cartId] ||= []).push({
            title: r.title ?? "-",
            price: Number(r.price || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      } else {
        const [cartItems] = await db.query(
          `
          SELECT
            pc.cartId                    AS cartId,
            pc.\`productId\`             AS productId,
            pc.\`count\`                 AS qty,
            COALESCE(pc.price, p.price)  AS price,
            p.title                      AS title
          FROM ProductOnCart pc
          LEFT JOIN product p ON p.id = pc.productId
          WHERE pc.cartId IN (?)
          `,
          [cartIds]
        );
        cartMap = cartItems.reduce((acc, r) => {
          (acc[r.cartId] ||= []).push({
            title: r.title ?? "-",
            price: Number(r.price || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      }
    }

    // ถ้าไม่มีสินค้าใน cart ⇒ fallback ไป Order
    const needFallback = slipRows.filter((s) => !(cartMap[s.cartId]?.length));
    const orderIdBySlipId = {};
    if (needFallback.length) {
      for (const s of needFallback) {
        if (!s.userId) continue;
        if (isPg) {
          const [orders] = await db.query(
            `
            SELECT o.id
            FROM "Order" o
            WHERE o."orderedById" = ?
              AND ROUND(o."cartTotal"::numeric, 2) = ROUND(?::numeric, 2)
            ORDER BY o."createdAt" DESC
            LIMIT 1
            `,
            [s.userId, s.amount]
          );
          if (orders.length) orderIdBySlipId[s.id] = orders[0].id;
        } else {
          const [orders] = await db.query(
            `
            SELECT o.id
            FROM \`Order\` o
            WHERE o.orderedById = ?
              AND ROUND(o.cartTotal, 2) = ROUND(?, 2)
            ORDER BY o.createdAt DESC
            LIMIT 1
            `,
            [s.userId, s.amount]
          );
          if (orders.length) orderIdBySlipId[s.id] = orders[0].id;
        }
      }
    }

    // สินค้าจาก ProductOnOrder
    let orderMap = {};
    const orderIds = Object.values(orderIdBySlipId);
    if (orderIds.length) {
      if (isPg) {
        const [orderItems] = await db.query(
          `
          SELECT
            po."orderId"                 AS "orderId",
            po."count"                   AS "qty",
            COALESCE(po.price, p.price)  AS "price",
            p.title                      AS "title"
          FROM "ProductOnOrder" po
          LEFT JOIN "Product" p ON p.id = po."productId"
          WHERE po."orderId" = ANY (?)
          `,
          [orderIds]
        );
        orderMap = orderItems.reduce((acc, r) => {
          (acc[r.orderId] ||= []).push({
            title: r.title ?? "-",
            price: Number(r.price || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      } else {
        const [orderItems] = await db.query(
          `
          SELECT
            po.orderId                   AS orderId,
            po.\`count\`                 AS qty,
            COALESCE(po.price, p.price)  AS price,
            p.title                      AS title
          FROM ProductOnOrder po
          LEFT JOIN product p ON p.id = po.productId
          WHERE po.orderId IN (?)
          `,
          [orderIds]
        );
        orderMap = orderItems.reduce((acc, r) => {
          (acc[r.orderId] ||= []).push({
            title: r.title ?? "-",
            price: Number(r.price || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      }
    }

    /* ========== Fallback สุดท้าย: อ่าน snapshot จาก payment_slip_items ========== */
    const slipIdsNeedSnapshot = slipRows
      .filter((s) => {
        const hasCartItems = !!(cartMap[s.cartId]?.length);
        const oid = orderIdBySlipId[s.id];
        const hasOrderItems = oid && orderMap[oid]?.length;
        return !hasCartItems && !hasOrderItems;
      })
      .map((s) => s.id);

    let bySlip = {};
    if (slipIdsNeedSnapshot.length) {
      if (isPg) {
        const [rows] = await db.query(
          `
          SELECT
            psi.slip_id AS "slip_id",
            psi.qty     AS "qty",
            psi.price   AS "price",
            psi.title   AS "title"
          FROM payment_slip_items psi
          WHERE psi.slip_id = ANY (?)
          `,
          [slipIdsNeedSnapshot]
        );
        bySlip = rows.reduce((acc, r) => {
          (acc[r.slip_id] ||= []).push({
            title: r.title ?? "-",
            price: Number(r.price || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      } else {
        const [rows] = await db.query(
          `
          SELECT
            psi.slip_id AS slip_id,
            psi.qty     AS qty,
            psi.price   AS price,
            psi.title   AS title
          FROM payment_slip_items psi
          WHERE psi.slip_id IN (?)
          `,
          [slipIdsNeedSnapshot]
        );
        bySlip = rows.reduce((acc, r) => {
          (acc[r.slip_id] ||= []).push({
            title: r.title ?? "-",
            price: Number(r.price || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      }
    }
    /* ======================== จบ fallback snapshot ======================== */

    const items = slipRows.map((s) => {
      let products = cartMap[s.cartId] || [];
      if (!products.length) {
        const oid = orderIdBySlipId[s.id];
        if (oid && orderMap[oid]?.length) products = orderMap[oid];
      }
      if (!products.length && bySlip[s.id]?.length) {
        products = bySlip[s.id];
      }
      return {
        id: s.id,
        cartId: s.cartId,
        userId: s.userId,
        userName: s.userName || null,
        userEmail: s.userEmail || null,
        amount: Number(s.amount || 0),
        status: String(s.status || "PENDING").toUpperCase(),
        slip_path: s.slip_path || "",
        slipUrl: publicUrlFromPath(req, s.slip_path || ""),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        shippingAddress: s.shippingAddress || null,
        products,
      };
    });

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("GET /api/admin/approve error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถดึงประวัติการสั่งซื้อได้" });
  }
});

/* ====================== ADMIN: เปลี่ยนสถานะสลิป (ย่อ) ====================== */
// PATCH /api/admin/slips/:id { action: 'approve'|'reject' }
router.patch("/admin/slips/:id", authCheck, adminCheck, async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);
    const action = String(req.body?.action || "").toLowerCase();
    const next = action === "approve" ? "APPROVED" : action === "reject" ? "REJECTED" : "PENDING";
    if (!id) return res.status(400).json({ message: "invalid id" });

    const slip = await fetchSlipCore(db, id);
    if (!slip) return res.status(404).json({ ok: false, message: "slip not found" });

    await deductStockIfApprove(db, slip.status, next, slip);

    await db.query(
      `UPDATE payment_slips SET status = ?, updated_at = NOW() WHERE id = ?`,
      [next, id]
    );
    return res.json({ ok: true, id, status: next });
  } catch (err) {
    console.error("PATCH /api/admin/slips/:id error:", err);
    return res.status(500).json({ ok: false, message: "server error" });
  }
});

/* ====================== ADMIN: เปลี่ยนสถานะสลิป (เต็มรูปแบบ) ====================== */
// PUT /api/admin/slips/:id/status  { status: 'PENDING'|'APPROVED'|'REJECTED' }
router.put("/admin/slips/:id/status", authCheck, adminCheck, async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);
    const next = String(req.body?.status || "").toUpperCase();
    if (!id || !["PENDING", "APPROVED", "REJECTED"].includes(next)) {
      return res.status(400).json({ message: "invalid id or status" });
    }

    const slip = await fetchSlipCore(db, id);
    if (!slip) return res.status(404).json({ ok: false, message: "slip not found" });

    await deductStockIfApprove(db, slip.status, next, slip);

    await db.query(
      `UPDATE payment_slips SET status = ?, updated_at = NOW() WHERE id = ?`,
      [next, id]
    );
    return res.json({ ok: true, id, status: next });
  } catch (err) {
    console.error("PUT /api/admin/slips/:id/status error:", err);
    return res.status(500).json({ ok: false, message: "server error" });
  }
});

/* ====================== ADMIN: ลบสลิป ====================== */
router.delete("/admin/slips/:id", authCheck, adminCheck, async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "invalid id" });

    const [[row]] = await db.query(`SELECT slip_path FROM payment_slips WHERE id = ?`, [id]);
    await db.query(`DELETE FROM payment_slips WHERE id = ?`, [id]);

    const slipPath = row?.slip_path || "";
    if (slipPath) {
      const abs = path.join(__dirname, "..", slipPath.replace(/^\/+/, ""));
      try {
        if (fs.existsSync(abs)) await fs.promises.unlink(abs);
      } catch {}
    }
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /admin/slips/:id error:", err);
    return res.status(500).json({ ok: false, message: "server error" });
  }
});

module.exports = router;
