// server/routes/order.js
const express = require("express");
const router = express.Router();
const { authCheck, adminCheck } = require("../middlewares/auth");

/** สร้าง URL สมบูรณ์จาก slip_path */
function publicUrlFromPath(req, p) {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  const origin = `${req.protocol}://${req.get("host")}`;
  return `${origin}${p.startsWith("/") ? "" : "/"}${p}`;
}

/* ====================== STOCK HELPERS (เพิ่มใหม่) ====================== */

/** มีคอลัมน์ stock_deducted ใน payment_slips ไหม (ใช้กันหักซ้ำ) */
async function hasStockFlag(db) {
  try {
    const [rows] = await db.query(`
      SELECT COUNT(*) AS c
      FROM information_schema.columns
      WHERE lower(table_name) = 'payment_slips'
        AND lower(column_name) = 'stock_deducted'
    `);
    return Number(rows?.[0]?.c || 0) > 0;
  } catch {
    return false;
  }
}

/** ดึงสลิปเฉพาะเขตข้อมูลที่ต้องใช้ */
async function fetchSlipById(db, id) {
  const [rows] = await db.query(
    `SELECT id, status, cart_id, user_id, amount FROM payment_slips WHERE id = ?`,
    [id]
  );
  return rows?.[0] || null;
}

/** อัปเดตสต็อกแบบปลอดภัย (อะตอมมิก): หักเท่าที่มีจริง และเพิ่ม sold ตามจำนวนที่หักจริง */
async function updateProductStock(db, productId, reqQty) {
  const want = Math.max(0, Number(reqQty || 0));
  if (want <= 0) return 0;

  // ตาราง product (ตัวพิมพ์เล็ก)
  try {
    const [r] = await db.query(
      `UPDATE product
         SET sold     = sold + LEAST(quantity, ?),
             quantity = GREATEST(quantity - ?, 0)
       WHERE id = ?`,
      [want, want, productId]
    );
    const affected = r?.affectedRows ?? r?.rowCount ?? 0;
    if (affected > 0) return affected;
  } catch {}

  // ตาราง "Product" (ตัวพิมพ์ใหญ่ - Prisma/Postgres)
  try {
    const [r2] = await db.query(
      `UPDATE "Product"
         SET sold     = sold + LEAST(quantity, ?),
             quantity = GREATEST(quantity - ?, 0)
       WHERE id = ?`,
      [want, want, productId]
    );
    const affected2 = r2?.rowCount ?? r2?.affectedRows ?? 0;
    if (affected2 > 0) return affected2;
  } catch {}

  return 0;
}

/** ดึงรายการสินค้า (productId, qty) จาก cart หรือ order ที่สัมพันธ์กับสลิป */
async function fetchItemsFromCartOrOrder(db, slip) {
  const isPg = db.dialect === "postgres";
  let items = [];

  // 1) จาก ProductOnCart
  try {
    if (slip.cart_id) {
      if (isPg) {
        const [rows] = await db.query(
          `SELECT "productId" AS productId, "count" AS qty
             FROM "ProductOnCart"
            WHERE "cartId" = ?`,
          [slip.cart_id]
        );
        items = rows;
      } else {
        const [rows] = await db.query(
          `SELECT productId AS productId, \`count\` AS qty
             FROM ProductOnCart
            WHERE cartId = ?`,
          [slip.cart_id]
        );
        items = rows;
      }
    }
  } catch {}

  // 2) หา order ด้วย cartId
  let orderId = null;
  if (!items?.length && slip.cart_id) {
    try {
      if (isPg) {
        const [orows] = await db.query(
          `SELECT id FROM "Order" WHERE "cartId" = ? ORDER BY "createdAt" DESC LIMIT 1`,
          [slip.cart_id]
        );
        orderId = orows?.[0]?.id ?? null;
      } else {
        const [orows] = await db.query(
          `SELECT id FROM \`Order\` WHERE cartId = ? ORDER BY createdAt DESC LIMIT 1`,
          [slip.cart_id]
        );
        orderId = orows?.[0]?.id ?? null;
      }
    } catch {}
  }

  // 3) หา order ด้วย (userId + amount) ถ้ายังหาไม่ได้
  if (!items?.length && !orderId && slip.user_id != null && slip.amount != null) {
    try {
      if (isPg) {
        const [orows] = await db.query(
          `
          SELECT id
            FROM "Order"
           WHERE "orderedById" = ?
             AND ROUND("cartTotal"::numeric, 2) = ROUND(?::numeric, 2)
        ORDER BY "createdAt" DESC
           LIMIT 1`,
          [slip.user_id, slip.amount]
        );
        orderId = orows?.[0]?.id ?? null;
      } else {
        const [orows] = await db.query(
          `
          SELECT id
            FROM \`Order\`
           WHERE orderedById = ?
             AND ROUND(cartTotal, 2) = ROUND(?, 2)
        ORDER BY createdAt DESC
           LIMIT 1`,
          [slip.user_id, slip.amount]
        );
        orderId = orows?.[0]?.id ?? null;
      }
    } catch {}
  }

  // 4) ถ้ามี orderId → ProductOnOrder
  if (!items?.length && orderId) {
    try {
      if (isPg) {
        const [rows] = await db.query(
          `SELECT "productId" AS productId, "count" AS qty
             FROM "ProductOnOrder"
            WHERE "orderId" = ?`,
          [orderId]
        );
        items = rows;
      } else {
        const [rows] = await db.query(
          `SELECT productId AS productId, \`count\` AS qty
             FROM ProductOnOrder
            WHERE orderId = ?`,
          [orderId]
        );
        items = rows;
      }
    } catch {}
  }

  return (items || [])
    .map((x) => ({ productId: Number(x.productId), qty: Number(x.qty || 0) }))
    .filter((x) => x.productId && x.qty > 0);
}

/** หักสต็อกครั้งเดียวต่อสลิป (เซ็ตธงแบบชัวร์ ๆ) */
async function deductStockOnceIfNeeded(db, slip) {
  const flagExists = await hasStockFlag(db);
  const isPg = db.dialect === "postgres";

  if (flagExists) {
    // อัปเดตธง + ยืนยันผล
    if (isPg) {
      // ใช้ RETURNING เพื่อตัดสินใจต่อ
      const [rows] = await db
        .query(
          `
          UPDATE payment_slips
             SET stock_deducted = TRUE
           WHERE id = ?
             AND COALESCE(stock_deducted, FALSE) = FALSE
          RETURNING id
          `,
          [slip.id]
        )
        .catch(() => [[]]);

      if (!rows?.length) return; // เคยหักไปแล้ว → จบ
    } else {
      const [res] = await db
        .query(
          `
          UPDATE payment_slips
             SET stock_deducted = TRUE
           WHERE id = ?
             AND COALESCE(stock_deducted, FALSE) = FALSE
          `,
          [slip.id]
        )
        .catch(() => [{}]);

      const affected = res?.affectedRows ?? res?.rowCount ?? 0;
      if (!affected) return; // เคยหักไปแล้ว → จบ
    }
  } else {
    // ไม่มีคอลัมน์กันซ้ำ → ถ้า slip เดิมเป็น APPROVED แล้ว ถือว่าหักไปแล้ว
    if (String(slip.status || "").toUpperCase() === "APPROVED") return;
  }

  // ถึงตรงนี้ = ต้องหักสต็อก (ครั้งแรก)
  const items = await fetchItemsFromCartOrOrder(db, slip);
  for (const it of items) {
    await updateProductStock(db, it.productId, it.qty);
  }
}

/* ====================== USER: บันทึกที่อยู่จัดส่ง (ของเดิม) ====================== */
// POST /api/user/address  { address, cartId }
router.post("/user/address", authCheck, async (req, res) => {
  const db = req.db;
  const isPg = db.dialect === "postgres";
  const { address, cartId } = req.body || {};
  const userId = req.user.id;

  if (!address || !cartId) {
    return res.status(400).json({ ok: false, message: "กรุณากรอกที่อยู่และ cartId" });
  }

  try {
    // 1) upsert ที่ table cart_addresses
    if (isPg) {
      await db.query(
        `
        INSERT INTO cart_addresses ("cartId", address, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        ON CONFLICT ("cartId")
        DO UPDATE SET address = EXCLUDED.address, updated_at = NOW()
        `,
        [cartId, String(address).trim()]
      );
    } else {
      await db.query(
        `
        INSERT INTO cart_addresses (cart_id, address, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE address = VALUES(address), updated_at = NOW()
        `,
        [cartId, String(address).trim()]
      );
    }

    // 2) snapshot address ไปยัง slip ที่ยัง PENDING ของ user รายนี้
    await db.query(
      `
      UPDATE payment_slips
         SET shipping_address = ?
       WHERE cart_id = ? AND user_id = ? AND status = 'PENDING'
      `,
      [String(address).trim(), cartId, userId]
    );

    return res.json({ ok: true, message: "บันทึกที่อยู่เรียบร้อยแล้ว" });
  } catch (error) {
    console.error("POST /api/user/address error:", error);
    return res.status(500).json({ ok: false, message: "ไม่สามารถบันทึกที่อยู่ได้" });
  }
});

/* ====================== USER: ประวัติคำสั่งซื้อ (อัปเดต) ====================== */
// GET /api/user/history
router.get("/user/history", authCheck, async (req, res) => {
  const db = req.db;
  const isPg = db.dialect === "postgres";
  const userId = req.user.id;

  try {
    // 1) สลิปของฉัน + ที่อยู่จาก cart_addresses
    let slips = [];
    if (isPg) {
      const [rows] = await db.query(
        `
        SELECT
          ps.id          AS slip_id,
          ps.cart_id     AS cart_id,
          ps.user_id     AS user_id,
          ps.amount      AS amount,
          ps.status      AS status,
          ps.slip_path   AS slip_path,
          ps.created_at  AS created_at,
          ps.updated_at  AS updated_at,
          ca.address     AS "shippingAddress"
        FROM payment_slips ps
        LEFT JOIN cart_addresses ca ON ca."cartId" = ps.cart_id
        WHERE ps.user_id = ?
        ORDER BY ps.created_at DESC
        `,
        [userId]
      );
      slips = rows;
    } else {
      const [rows] = await db.query(
        `
        SELECT
          ps.id          AS slip_id,
          ps.cart_id     AS cart_id,
          ps.user_id     AS user_id,
          ps.amount      AS amount,
          ps.status      AS status,
          ps.slip_path   AS slip_path,
          ps.created_at  AS created_at,
          ps.updated_at  AS updated_at,
          ca.address     AS shippingAddress
        FROM payment_slips ps
        LEFT JOIN cart_addresses ca ON ca.cart_id = ps.cart_id
        WHERE ps.user_id = ?
        ORDER BY ps.created_at DESC
        `,
        [userId]
      );
      slips = rows;
    }

    if (!slips.length) return res.json({ ok: true, orders: [] });

    // 2) รายการสินค้าจาก ProductOnCart (ตาม cartId)
    const cartIds = [...new Set(slips.map((s) => s.cart_id).filter(Boolean))];
    let byCart = {};
    if (cartIds.length) {
      if (isPg) {
        const [items] = await db.query(
          `
          SELECT
            pc."cartId"                 AS cart_id,
            pc."count"                  AS qty,
            COALESCE(pc.price, p.price) AS price,
            p.title                     AS title
          FROM "ProductOnCart" pc
          LEFT JOIN "Product" p ON p.id = pc."productId"
          WHERE pc."cartId" = ANY (?)
          `,
          [cartIds]
        );
        byCart = items.reduce((acc, r) => {
          (acc[r.cart_id] ||= []).push({
            product: { title: r.title, price: Number(r.price || 0) },
            title: r.title,
            price: Number(r.price || 0),
            count: Number(r.qty || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      } else {
        const [items] = await db.query(
          `
          SELECT
            pc.cartId                   AS cart_id,
            pc.\`count\`                AS qty,
            COALESCE(pc.price, p.price) AS price,
            p.title                     AS title
          FROM ProductOnCart pc
          LEFT JOIN product p ON p.id = pc.productId
          WHERE pc.cartId IN (?)
          `,
          [cartIds]
        );
        byCart = items.reduce((acc, r) => {
          (acc[r.cart_id] ||= []).push({
            product: { title: r.title, price: Number(r.price || 0) },
            title: r.title,
            price: Number(r.price || 0),
            count: Number(r.qty || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      }
    }

    // 3) ถ้าตะกร้าไม่มี item → หา Order ด้วย userId+amount (ล่าสุด)
    const needFallback = slips.filter((s) => !(byCart[s.cart_id]?.length));
    const orderIdBySlipId = {};
    if (needFallback.length) {
      for (const s of needFallback) {
        if (!s.user_id) continue;
        if (isPg) {
          const [orders] = await db.query(
            `
            SELECT o.id
              FROM "Order" o
             WHERE o."orderedById" = ?
               AND ROUND(o."cartTotal"::numeric, 2) = ROUND(?::numeric, 2)
          ORDER BY o."createdAt" DESC
             LIMIT 1`,
            [s.user_id, s.amount]
          );
          if (orders?.length) orderIdBySlipId[s.slip_id] = orders[0].id;
        } else {
          const [orders] = await db.query(
            `
            SELECT o.id
              FROM \`Order\` o
             WHERE o.orderedById = ?
               AND ROUND(o.cartTotal, 2) = ROUND(?, 2)
          ORDER BY o.createdAt DESC
             LIMIT 1`,
            [s.user_id, s.amount]
          );
          if (orders?.length) orderIdBySlipId[s.slip_id] = orders[0].id;
        }
      }
    }

    // 4) รายการสินค้าจาก ProductOnOrder ของ orderIds ที่แมปได้
    const orderIds = Object.values(orderIdBySlipId);
    let byOrder = {};
    if (orderIds.length) {
      if (isPg) {
        const [rows] = await db.query(
          `
          SELECT
            po."orderId"                AS orderId,
            po."count"                  AS qty,
            COALESCE(po.price, p.price) AS price,
            p.title                     AS title
          FROM "ProductOnOrder" po
          LEFT JOIN "Product" p ON p.id = po."productId"
          WHERE po."orderId" = ANY (?)
          `,
          [orderIds]
        );
        byOrder = rows.reduce((acc, r) => {
          (acc[r.orderId] ||= []).push({
            product: { title: r.title, price: Number(r.price || 0) },
            title: r.title,
            price: Number(r.price || 0),
            count: Number(r.qty || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      } else {
        const [rows] = await db.query(
          `
          SELECT
            po.orderId                  AS orderId,
            po.\`count\`                AS qty,
            COALESCE(po.price, p.price) AS price,
            p.title                     AS title
          FROM ProductOnOrder po
          LEFT JOIN product p ON p.id = po.productId
          WHERE po.orderId IN (?)
          `,
          [orderIds]
        );
        byOrder = rows.reduce((acc, r) => {
          (acc[r.orderId] ||= []).push({
            product: { title: r.title, price: Number(r.price || 0) },
            title: r.title,
            price: Number(r.price || 0),
            count: Number(r.qty || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      }
    }

    // ========== 4.5) Fallback ใหม่: อ่าน snapshot จาก payment_slip_items ==========
    const slipIdsNeedSnapshot = slips
      .filter((s) => {
        const hasCartItems = !!byCart[s.cart_id]?.length;
        const oid = orderIdBySlipId[s.slip_id];
        const hasOrderItems = oid && byOrder[oid]?.length;
        return !hasCartItems && !hasOrderItems;
      })
      .map((s) => s.slip_id);

    let bySlip = {};
    if (slipIdsNeedSnapshot.length) {
      if (isPg) {
        const [rows] = await db.query(
          `
          SELECT
            psi.slip_id AS slip_id,
            psi.qty     AS qty,
            psi.price   AS price,
            psi.title   AS title
          FROM payment_slip_items psi
          WHERE psi.slip_id = ANY (?)
          `,
          [slipIdsNeedSnapshot]
        );
        bySlip = rows.reduce((acc, r) => {
          (acc[r.slip_id] ||= []).push({
            product: { title: r.title, price: Number(r.price || 0) },
            title: r.title,
            price: Number(r.price || 0),
            count: Number(r.qty || 0),
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
            product: { title: r.title, price: Number(r.price || 0) },
            title: r.title,
            price: Number(r.price || 0),
            count: Number(r.qty || 0),
            qty: Number(r.qty || 0),
          });
          return acc;
        }, {});
      }
    }
    // ========== จบ 4.5 ==========

    // 5) payload ส่งให้ฟรอนต์
    const orders = slips.map((s) => {
      let products = byCart[s.cart_id] || [];
      if (!products.length) {
        const oid = orderIdBySlipId[s.slip_id];
        if (oid && byOrder[oid]?.length) products = byOrder[oid];
      }
      if (!products.length && bySlip[s.slip_id]?.length) {
        products = bySlip[s.slip_id];
      }

      return {
        id: s.slip_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        cartTotal: Number(s.amount || 0),
        orderStatus: "processing",
        slipStatus: String(s.status || "PENDING").toLowerCase(),
        products,
        slipPath: s.slip_path,
        slipUrl: publicUrlFromPath(req, s.slip_path),
        cartId: s.cart_id,
        shippingAddress: s.shippingAddress || null,
      };
    });

    return res.json({ ok: true, orders });
  } catch (err) {
    console.error("GET /api/user/history error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถดึงประวัติการสั่งซื้อได้" });
  }
});


/* ====================== ADMIN: เปลี่ยนสถานะสลิป + ลบสลิป (ของเดิม) ====================== */
const ALLOW = ["PENDING", "APPROVED", "REJECTED"];

/** PUT /api/admin/slips/:id/status  { status } */
router.put("/admin/slips/:id/status", authCheck, adminCheck, async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  let { status } = req.body || {};
  status = String(status || "").toUpperCase();

  if (!ALLOW.includes(status)) {
    return res.status(400).json({ ok: false, message: "invalid status" });
  }

  try {
    const slip = await fetchSlipById(db, id);
    if (!slip) return res.status(404).json({ ok: false, message: "slip not found" });

    // อัปเดตสถานะ
    await db.query(
      `UPDATE payment_slips SET status = ?, updated_at = NOW() WHERE id = ?`,
      [status, id]
    );

    // อ่านสลิปล่าสุดหลังอัปเดต
    const slipAfter = await fetchSlipById(db, id);

    // ถ้าอนุมัติ → หักสต็อกครั้งเดียว
    if (status === "APPROVED") {
      await deductStockOnceIfNeeded(db, slipAfter);
    }

    // ส่งข้อมูลล่าสุดกลับ
    const [rows] = await db.query(
      `SELECT id AS slip_id, cart_id, user_id, amount, status, slip_path, created_at, updated_at
         FROM payment_slips WHERE id = ?`,
      [id]
    );
    const s = rows[0];
    return res.json({
      ok: true,
      item: {
        id: s.slip_id,
        cartId: s.cart_id,
        userId: s.user_id,
        amount: Number(s.amount),
        status: s.status,
        slipUrl: publicUrlFromPath(req, s.slip_path),
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      },
    });
  } catch (e) {
    console.error("PUT /api/admin/slips/:id/status error:", e);
    return res.status(500).json({ ok: false, message: e.message || "server error" });
  }
});

/** PATCH /api/admin/slips/:id  { action: 'approve' | 'reject' } */
router.patch("/admin/slips/:id", authCheck, adminCheck, async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const action = String(req.body?.action || "").toLowerCase();
  const next =
    action === "approve" ? "APPROVED" :
    action === "reject"  ? "REJECTED" :
    "PENDING";

  try {
    const slip = await fetchSlipById(db, id);
    if (!slip) return res.status(404).json({ ok: false, message: "slip not found" });

    await db.query(
      `UPDATE payment_slips SET status = ?, updated_at = NOW() WHERE id = ?`,
      [next, id]
    );

    const slipAfter = await fetchSlipById(db, id);

    if (next === "APPROVED") {
      await deductStockOnceIfNeeded(db, slipAfter);
    }

    return res.json({ ok: true, id, status: next });
  } catch (e) {
    console.error("PATCH /api/admin/slips/:id error:", e);
    return res.status(500).json({ ok: false, message: e.message || "server error" });
  }
});

/** DELETE /api/admin/slips/:id */
router.delete("/admin/slips/:id", authCheck, adminCheck, async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  try {
    if (!id) return res.status(400).json({ ok: false, message: "invalid id" });
    const [r] = await db.query(`DELETE FROM payment_slips WHERE id = ?`, [id]);
    const affected = r?.affectedRows ?? r?.rowCount ?? 0;
    if (!affected) {
      return res.status(404).json({ ok: false, message: "slip not found" });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/admin/slips/:id error:", e);
    return res.status(500).json({ ok: false, message: e.message || "server error" });
  }
});

module.exports = router;
